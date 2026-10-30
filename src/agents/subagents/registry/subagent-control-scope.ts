import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { execRequestMatches, type ExecRequestOwner } from "../../../infra/exec-request-context.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeAgentIdStrict,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import type { SessionCapabilityLookup } from "../spawn/subagent-session-store.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  detachedRootAuthorizationError,
  selectEntriesWithCurrentChildRoot,
  type ChildRootAuthorization,
  type SyncOnly,
} from "./subagent-control-root-authority.js";
import type { ResolvedSubagentController } from "./subagent-control.types.js";
import {
  readSubagentExecRequestController,
  type SubagentRequestSessionOrigin,
} from "./subagent-exec-request-ownership.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { captureSubagentListReadContext, type SubagentListReadContext } from "./subagent-list.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildSubagentRunReadIndexFromRuns,
  listRunsForControllerFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRequesterSettleWakeForRun } from "./subagent-requester-settle-identity.js";
import {
  isSameSubagentRun,
  isSameSubagentRunOwner,
  getSubagentRunRuntimeKey,
  latestSubagentRun,
} from "./subagent-run-generation.js";

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;

/** Resolve caller routing before preparing its persisted capability facts. */
export function resolveSubagentControllerIdentity(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
}): Omit<ResolvedSubagentController, "controlScope"> {
  const { alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({ key: callerRaw, alias });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: callerSessionKey,
    agentId: params.agentId,
  });
  return {
    controllerSessionKey: callerSessionKey,
    controllerAgentId,
    callerSessionKey,
    callerIsSubagent: isSubagentSessionKey(callerSessionKey),
  };
}

export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  capabilityStore?: SessionCapabilityLookup;
}): ResolvedSubagentController {
  const identity = resolveSubagentControllerIdentity(params);
  if (!identity.callerIsSubagent) {
    return { ...identity, controlScope: "children" };
  }
  const capabilities = resolveStoredSubagentCapabilities(identity.callerSessionKey, {
    cfg: params.cfg,
    agentId: identity.controllerAgentId,
    store: params.capabilityStore,
  });
  return {
    ...identity,
    controlScope: capabilities.controlScope,
  };
}

function listControlledSubagentRunsForTurn(
  cfg: OpenClawConfig,
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">,
  requesterTurnRunId?: string,
): SubagentRunRecord[] {
  // Cancellation owns only current resident runs; acquire their dispatch holds before yielding.
  const controlledRuns = listRunsForControllerFromRuns(
    subagentRuns,
    controller.controllerSessionKey,
  ).filter((entry) => !subagentControllerCandidateError({ cfg, controller, entry }));
  if (requesterTurnRunId === undefined) {
    return controlledRuns;
  }
  const requesterRuns = listSubagentRunsForRequester(controller.controllerSessionKey, {
    requesterAgentId: controller.controllerAgentId,
  });
  const runsById = new Map(
    requesterRuns
      .filter((entry) =>
        isSameSubagentRun(
          getLatestLiveSubagentRunByChildSessionKey(
            entry.childSessionKey,
            undefined,
            entry.childAgentId,
          ),
          entry,
        ),
      )
      .map((entry) => [entry.runId, entry]),
  );
  return controlledRuns.filter(
    (entry) =>
      entry.requesterTurnRunId === requesterTurnRunId ||
      isRequesterSettleWakeForRun({
        entry,
        runId: requesterTurnRunId,
        requesterSessionKey: controller.controllerSessionKey,
        requesterAgentId: controller.controllerAgentId,
        runsById,
      }),
  );
}

export type ExecRequestSubagentSelection = {
  runs: SubagentRunRecord[];
  ownsRoot: (entry: SubagentRunRecord) => boolean;
  selectPublishedRoot?: (entry: SubagentRunRecord) => boolean;
  sessionGeneration?: SubagentRequestSessionOrigin["target"];
};

/** Freeze native owners before cancellation yields; routed IDs never grant control. */
export function captureExecRequestSubagentSelection(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  requesterTurnRunId?: string;
  owners: readonly ExecRequestOwner[];
  sessionOrigin?: SubagentRequestSessionOrigin;
}): ExecRequestSubagentSelection {
  const owners = new Set(params.owners);
  const origin = params.requesterTurnRunId === undefined ? params.sessionOrigin : undefined;
  if (
    origin &&
    (origin.target.sessionKey !== params.controller.controllerSessionKey ||
      origin.target.agentId !== params.controller.controllerAgentId)
  ) {
    throw new Error("Native Stop origin does not match its admitted controller.");
  }
  const acceptsOrigin = (owner: ExecRequestOwner) =>
    Boolean(
      origin && execRequestMatches(owner, origin.target) && origin.acceptsRequest(owner.identity),
    );
  const turnIds = params.requesterTurnRunId
    ? [
        ...new Set([
          params.requesterTurnRunId,
          ...params.owners.flatMap((owner) => [...owner.turnRunIds]),
        ]),
      ]
    : [undefined];
  type ControllerIdentity = Pick<
    ResolvedSubagentController,
    "controllerSessionKey" | "controllerAgentId"
  >;
  const selected = new Map<
    object,
    {
      entry: SubagentRunRecord;
      controller: ControllerIdentity;
      requestOwners?: ReadonlySet<ExecRequestOwner>;
    }
  >();
  const capture = (
    entry: SubagentRunRecord,
    controller: ControllerIdentity,
    requestOwners?: ReadonlySet<ExecRequestOwner>,
  ) => {
    const key = getSubagentRunRuntimeKey(entry);
    if (selected.has(key)) {
      return false;
    }
    selected.set(key, { entry, controller, requestOwners });
    return true;
  };
  const selectPublishedRoot = (entry: SubagentRunRecord) => {
    const controller = readSubagentExecRequestController(entry, (owner) => owners.has(owner));
    return controller !== undefined && capture(entry, controller, owners);
  };
  let selectedByOrigin = false;
  for (const runId of turnIds) {
    for (const entry of listControlledSubagentRunsForTurn(params.cfg, params.controller, runId)) {
      capture(entry, params.controller);
    }
  }
  if (owners.size > 0 || origin) {
    for (const entry of subagentRuns.values()) {
      const controller = readSubagentExecRequestController(entry, (owner) => owners.has(owner));
      if (controller) {
        capture(entry, controller, owners);
      } else if (origin) {
        const originOwners = new Set<ExecRequestOwner>();
        const originController = readSubagentExecRequestController(entry, (owner) => {
          if (!acceptsOrigin(owner)) {
            return false;
          }
          originOwners.add(owner);
          return true;
        });
        if (originController) {
          selectedByOrigin = capture(entry, originController, originOwners) || selectedByOrigin;
        }
      }
    }
  }
  return {
    runs: [...selected.values()].map(({ entry }) => entry),
    // Late publication must prove the captured request object, never a new session match.
    selectPublishedRoot: owners.size > 0 ? selectPublishedRoot : undefined,
    sessionGeneration: selectedByOrigin ? origin?.target : undefined,
    ownsRoot(entry) {
      const captured = selected.get(getSubagentRunRuntimeKey(entry));
      return Boolean(
        captured &&
        isSameSubagentRunOwner(entry, captured.entry) &&
        // Accepted native settlement retains the published binding. Live caller
        // and origin-generation checks belong to cancellationControl's fresh effects.
        (!captured.requestOwners ||
          readSubagentExecRequestController(
            entry,
            (owner) => captured.requestOwners?.has(owner) === true,
          )) &&
        // Candidate only. Kill preparation is the incarnation and root fence.
        !subagentControllerCandidateError({
          cfg: params.cfg,
          controller: captured.controller,
          entry,
        }),
      );
    },
  };
}

function resolveRunRequesterAgentId(
  entry: Pick<SubagentRunReadRecord, "requesterSessionKey" | "requesterAgentId">,
  cfg?: OpenClawConfig,
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  const parsed = parseAgentSessionKey(entry.requesterSessionKey)?.agentId;
  if (parsed || !cfg) {
    return parsed;
  }
  return resolveSubagentRequesterAgentId(cfg, entry);
}

/** Registry candidate. Not a child-root proof; publication must pass root facts. */
export function isSubagentRunCandidateForSession(
  entry: SubagentRunReadRecord,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): boolean {
  if (entry.childHandoff) {
    return false;
  }
  return sessionMatchesRunOwner(entry, sessionKey, agentId, cfg);
}

export function isSubagentRunVisibleToSession(
  entry: SubagentRunReadRecord,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
  rootFacts?: ChildRootAuthorization,
): boolean {
  if (entry.childHandoff) {
    // The child was promoted to a standard session; its former parent no longer sees it.
    return false;
  }
  // Omitted facts are not visibility. Callers fence with a current child-root proof.
  if (!rootFacts || detachedRootAuthorizationError(entry, rootFacts)) {
    return false;
  }
  return sessionMatchesRunOwner(entry, sessionKey, agentId, cfg);
}

function sessionMatchesRunOwner(
  entry: SubagentRunReadRecord,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): boolean {
  const controllerKey = entry.controllerSessionKey?.trim();
  const requesterKey = entry.requesterSessionKey.trim();
  // Completion routing can target a different session than control ownership.
  // Both owners may read the run, while ensureControllerOwnsRun still gates mutations.
  const requesterAgentId = resolveRunRequesterAgentId(entry, cfg);
  const controllerAgentId =
    (controllerKey ? parseAgentSessionKey(controllerKey)?.agentId : undefined) ?? requesterAgentId;
  const normalizedAgentId = normalizeAgentId(agentId);
  return (
    (controllerKey === sessionKey && controllerAgentId === normalizedAgentId) ||
    (requesterKey === sessionKey && requesterAgentId === normalizedAgentId)
  );
}

export type ControlledSubagentRunsReadContext = {
  runs: SubagentRunRecord[];
  list: SubagentListReadContext;
  getExecutionObservation(entry: SubagentRunRecord): ReturnType<typeof observeSubagentExecution>;
};

export type ControlledSubagentRead = {
  readonly candidateContext: ControlledSubagentRunsReadContext;
  prepareRead(): Promise<void> | undefined;
  commitSync<R>(
    render: (current: ControlledSubagentRunsReadContext) => R,
    ...forbidPromise: SyncOnly<R>
  ): R;
  assertTargetCurrentSync(runId: string): void;
  release(): void;
};

function selectControlledSubagentRunFacts(
  index: SubagentRunReadIndex<SubagentRunReadRecord>,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): SubagentRunReadRecord[] {
  return [...index.runsByChildSessionKey.values()].flatMap((runs) =>
    runs.filter(
      (entry) =>
        isSubagentRunCandidateForSession(entry, sessionKey, agentId, cfg) &&
        (entry.childAgentId === undefined
          ? index.latestRunsByChildSessionKey.get(entry.childSessionKey.trim())
          : latestSubagentRun(runs, (candidate) =>
              matchesSubagentChildSessionOwner(
                candidate,
                entry.childSessionKey,
                entry.childAgentId,
              ),
            )) === entry,
    ),
  );
}

/** Builds one stable snapshot for controlled-run listing and descendant status reads. */
export async function buildControlledSubagentRunsReadContext(
  controllerSessionKey: string,
  controllerAgentId?: string,
  cfg?: OpenClawConfig,
  recentMinutes = DEFAULT_RECENT_MINUTES,
): Promise<ControlledSubagentRead> {
  const key = controllerSessionKey.trim();
  const agentId = controllerAgentId ?? parseAgentSessionKey(key)?.agentId;
  if (!key || !agentId) {
    const empty: ControlledSubagentRunsReadContext = {
      runs: [],
      list: captureSubagentListReadContext(
        [],
        buildSubagentRunReadIndexFromRuns({ runs: new Map() }),
        new Map(),
        recentMinutes,
      ),
      getExecutionObservation: () => ({ state: "unknown" }),
    };
    let released = false;
    const active = () => {
      if (released) throw new Error("Controlled read released.");
    };
    return {
      candidateContext: empty,
      prepareRead: () => {
        active();
        return undefined;
      },
      commitSync: <R>(
        render: (current: ControlledSubagentRunsReadContext) => R,
        ..._forbidPromise: SyncOnly<R>
      ) => {
        active();
        const result = render(empty);
        if (result != null && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Renderer must be synchronous.");
        return result;
      },
      assertTargetCurrentSync: () => {
        active();
        throw new Error("Subagent target is no longer authorized.");
      },
      release: () => {
        released = true;
      },
    };
  }

  const select = (snapshot: Map<string, SubagentRunReadRecord>) => {
    const index = buildSubagentRunReadIndexFromRuns({
      runs: snapshot,
      inMemoryRuns: [...snapshot.keys()].flatMap((id) => subagentRuns.get(id) ?? []),
    });
    const visible = selectControlledSubagentRunFacts(index, key, agentId, cfg);
    return {
      index,
      runIds: visible.map((entry) => entry.runId),
      sessionKeys: visible
        .filter((entry) => entry.pauseReason === "sessions_yield")
        .map((entry) => entry.childSessionKey),
    };
  };
  const captured = await withSubagentRunReadSnapshot(
    subagentRuns,
    select,
    (selection, snapshot) => {
      const visibleIds = new Set(selection.runIds);
      return {
        index: selection.index,
        snapshot,
        candidates: [...snapshot.values()].filter((entry) => visibleIds.has(entry.runId)),
      };
    },
    { sessionKeys: [key], descendants: true },
  );
  const selection = cfg
    ? await selectEntriesWithCurrentChildRoot(cfg, captured.candidates)
    : undefined;
  let released = false;
  const active = () => {
    if (released) throw new Error("Controlled read released.");
  };
  const makeContext = (
    allowed: readonly SubagentRunRecord[],
  ): ControlledSubagentRunsReadContext => {
    const allowedIds = new Set(allowed.map((entry) => entry.runId));
    const denied = new Set<string>(
      captured.candidates
        .filter((entry) => !allowedIds.has(entry.runId))
        .map((entry) => entry.childSessionKey),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of allowed) {
        if (denied.has(entry.requesterSessionKey) && !denied.has(entry.childSessionKey)) {
          denied.add(entry.childSessionKey);
          changed = true;
        }
      }
    }
    const filtered = allowed.filter((entry) => !denied.has(entry.childSessionKey));
    const list = hideDeniedChildSessionKeys(
      captureSubagentListReadContext(filtered, captured.index, captured.snapshot, recentMinutes),
      denied,
    );
    return {
      runs: list.view.latest,
      list,
      getExecutionObservation: (entry: SubagentRunRecord) =>
        observeSubagentExecution(entry, getSubagentRunsForRequesterSession(entry.childSessionKey)),
    };
  };
  const candidateContext = makeContext(captured.candidates);
  const withCurrent = <R>(render: (current: ControlledSubagentRunsReadContext) => R): R => {
    active();
    if (!selection || !cfg) {
      const result = render(candidateContext);
      if (result != null && typeof (result as { then?: unknown }).then === "function")
        throw new TypeError("Renderer must be synchronous.");
      return result;
    }
    return selection.commitSync(
      (entry, facts) => isSubagentRunVisibleToSession(entry, key, agentId, cfg, facts),
      (accepted) => {
        const result = render(makeContext(accepted));
        if (result != null && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Renderer must be synchronous.");
        return result;
      },
      ...([] as unknown as SyncOnly<R>),
    );
  };
  return {
    candidateContext,
    prepareRead: () => {
      active();
      return selection?.prepareRead();
    },
    commitSync: withCurrent as ControlledSubagentRead["commitSync"],
    assertTargetCurrentSync: (runId) => {
      const found = withCurrent((current) => current.runs.some((entry) => entry.runId === runId));
      if (!found) throw new Error("Subagent target is no longer authorized.");
    },
    release: () => {
      if (!released) {
        released = true;
        selection?.release();
      }
    },
  };
}

export function hideDeniedChildSessionKeys(
  list: SubagentListReadContext,
  deniedSessionKeys: ReadonlySet<string>,
): SubagentListReadContext {
  if (deniedSessionKeys.size === 0) {
    return list;
  }
  return {
    ...list,
    // Graph-derived aggregates may include a denied branch; do not disclose stale counts.
    pendingDescendants: new Map(),
    execution: new Map(
      [...list.execution].map(([runId, observation]) => [
        runId,
        observation.wait ? { ...observation, wait: { kind: observation.wait.kind } } : observation,
      ]),
    ),
    childSessionsByController: new Map(
      [...list.childSessionsByController].map(([controllerKey, children]) => [
        controllerKey,
        children.filter((sessionKey) => !deniedSessionKeys.has(sessionKey)),
      ]),
    ),
  };
}

/** Cancellation consumes current ownership facts without hydrating retained result payloads. */
export function listControlledSubagentRunFacts(
  controllerSessionKey: string,
  controllerAgentId: string | undefined,
  cfg: OpenClawConfig,
): SubagentRunReadRecord[] {
  if (!controllerAgentId) {
    return [];
  }
  const index = buildSubagentRunReadIndexFromRuns({
    runs: getSubagentSessionListRunsSnapshotForRead(subagentRuns),
  });
  return selectControlledSubagentRunFacts(index, controllerSessionKey, controllerAgentId, cfg);
}

/** Sync selector. Kill preparation still has to prove the child incarnation. */
export function subagentControllerCandidateError(params: {
  cfg: OpenClawConfig;
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
  entry: SubagentRunReadRecord;
}) {
  if (params.entry.childHandoff) {
    return "This session was promoted to a standard session; its former parent no longer controls it.";
  }
  return controllerMatchError(params);
}

export function ensureSubagentControllerOwnsRun(params: {
  cfg: OpenClawConfig;
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
  entry: SubagentRunReadRecord;
  /** Current child-root proof. Omitting it denies; it is not the legacy allow path. */
  rootFacts?: ChildRootAuthorization;
}) {
  if (params.entry.childHandoff) {
    // A human promoted the child to a standard session: no former controller steers, waits on,
    // resumes or cancels it, or reaches the work it started itself.
    return "This session was promoted to a standard session; its former parent no longer controls it.";
  }
  if (!params.rootFacts) {
    return "Session ownership could not be proved; former-parent control is refused.";
  }
  const detachedRootError = detachedRootAuthorizationError(params.entry, params.rootFacts);
  if (detachedRootError) {
    return detachedRootError;
  }
  return controllerMatchError(params);
}

function controllerMatchError(params: {
  cfg: OpenClawConfig;
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
  entry: SubagentRunReadRecord;
}) {
  const controllerKey = params.entry.controllerSessionKey?.trim();
  const owner = controllerKey || params.entry.requesterSessionKey;
  const ownerStorePath = controllerKey
    ? params.entry.controllerStorePath
    : params.entry.requesterStorePath;
  const ownerAgentId =
    parseAgentSessionKey(owner)?.agentId ?? resolveRunRequesterAgentId(params.entry, params.cfg);
  const controllerAgentId =
    params.controller.controllerAgentId ??
    parseAgentSessionKey(params.controller.controllerSessionKey)?.agentId;
  if (
    owner === params.controller.controllerSessionKey &&
    ownerAgentId === controllerAgentId &&
    // Retained v2026.9.5 tasks lack store provenance; preserve their control until retirement.
    (ownerStorePath === undefined || isSystemEventStoreCurrent(owner, ownerStorePath, ownerAgentId))
  ) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

export function getLatestOwnedSubagentRun(
  childSessionKey: string,
  agentId: string | undefined,
  cfg: OpenClawConfig,
): SubagentRunRecord | undefined {
  const key = childSessionKey.trim();
  // Qualified keys own their namespace; legacy raw rows retain requester-agent separation.
  const owner =
    agentId === undefined || parseAgentSessionKey(key)
      ? undefined
      : normalizeAgentIdStrict(agentId);
  return (
    getLatestLiveSubagentRunByChildSessionKey(
      key,
      owner === undefined
        ? undefined
        : (candidate) =>
            owner.ok &&
            matchesSubagentChildSessionOwner(candidate, key, owner.value) &&
            (candidate.childAgentId !== undefined ||
              resolveRunRequesterAgentId(candidate, cfg) === owner.value),
    ) ?? undefined
  );
}

export function isCurrentSubagentRun(entry: SubagentRunRecord, cfg: OpenClawConfig): boolean {
  return isSameSubagentRunOwner(
    getLatestOwnedSubagentRun(
      entry.childSessionKey,
      entry.childAgentId ?? resolveRunRequesterAgentId(entry, cfg),
      cfg,
    ),
    entry,
  );
}
