import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { ChatGuardianNotice, ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import type { CompactionStatus, RunOutputUsage } from "./tool-stream-contract.ts";

type WorkingProgress = {
  key: string;
  runId: string | null;
  startedAt: number;
};

const CONTEXT_COMPACTION_CUSTOM_TYPE = "openclaw.context-compaction";

export function isContextCompactionMessage(message: unknown): boolean {
  const record = asRecord(message);
  return record?.role === "custom" && record.customType === CONTEXT_COMPACTION_CUSTOM_TYPE;
}

export function matchesCompactionOperation(message: unknown, status: CompactionStatus): boolean {
  const record = asRecord(message);
  const marker = asRecord(record?.["__openclaw"]);
  return Boolean(
    (marker?.kind === "compaction" || isContextCompactionMessage(message)) &&
    status.runId &&
    marker?.runId === status.runId &&
    (!status.itemId || marker.itemId === status.itemId),
  );
}

const workingProgressBySession = new Map<string, WorkingProgress>();
let anonymousWorkingProgressId = 0;

export function buildGuardianNoticeItem(
  notice: ChatGuardianNotice,
): Extract<ChatItem, { kind: "notice" }> {
  const action = notice.command ?? t("chat.systemNotice.guardian.requestedAction");
  const item = {
    kind: "notice" as const,
    key: notice.key,
    icon: "shieldCheck" as const,
    timestamp: notice.timestamp,
  };
  if (notice.source === "system") {
    return {
      ...item,
      icon: "cpu",
      label: t("common.system"),
      text: notice.message ?? "",
    };
  }
  if (notice.kind === "approved") {
    return {
      ...item,
      label: t("chat.systemNotice.guardian.approvedSummary", { action }),
      text: "",
    };
  }
  if (notice.kind === "warning") {
    return {
      ...item,
      label: t("chat.systemNotice.guardian.warningLabel"),
      text: notice.message ?? t("chat.systemNotice.guardian.warningFallback"),
      tone: "danger",
    };
  }
  if (notice.kind === "reviewing" || notice.kind === "strict-review-required") {
    return {
      ...item,
      label: t("chat.systemNotice.guardian.strictReviewRequiredLabel"),
      text: t("chat.systemNotice.guardian.strictReviewRequiredSummary"),
      tone: "danger",
    };
  }
  return {
    ...item,
    label: t("chat.systemNotice.guardian.deniedLabel"),
    text: t("chat.systemNotice.guardian.deniedSummary", {
      action,
      risk: notice.riskLevel ?? t("chat.systemNotice.guardian.unknownRisk"),
      rationale: notice.rationale ?? t("chat.systemNotice.guardian.noRationale"),
    }),
    tone: "danger",
  };
}

export function buildCompactionDividerItem(
  marker: Record<string, unknown>,
  timestamp: number,
  index: number,
  phase: "active" | "complete" = "complete",
): Extract<ChatItem, { kind: "divider" }> {
  const tokensBefore = marker.tokensBefore;
  const tokensAfter = marker.tokensAfter;
  const tokensSaved =
    typeof tokensBefore === "number" &&
    Number.isFinite(tokensBefore) &&
    typeof tokensAfter === "number" &&
    Number.isFinite(tokensAfter) &&
    tokensBefore > tokensAfter
      ? Math.floor(tokensBefore - tokensAfter)
      : null;
  return {
    kind: "divider",
    key:
      typeof marker.id === "string"
        ? `divider:compaction:${marker.id}`
        : `divider:compaction:${timestamp}:${index}`,
    label: t(
      phase === "active" ? "chat.composer.compactingContext" : "chat.composer.contextCompacted",
    ),
    compaction: phase,
    ...(tokensSaved === null
      ? {}
      : {
          metric: t("chat.compaction.savedTokens", {
            count: formatCompactTokenCount(tokensSaved),
          }),
        }),
    timestamp,
  };
}

export function buildResetDividerItem(
  marker: Record<string, unknown>,
  timestamp: number,
  index: number,
): Extract<ChatItem, { kind: "divider" }> {
  return {
    kind: "divider",
    key:
      typeof marker.id === "string"
        ? `divider:reset:${marker.id}`
        : `divider:reset:${timestamp}:${index}`,
    label: t("chat.sessionReset.label"),
    icon: "rotateCcw",
    description: t("chat.sessionReset.description"),
    timestamp,
  };
}

function queuedSendStarted(item: ChatQueueItem): boolean {
  // Submitting offline records timing without attempting delivery.
  return (
    (item.sendAttempts ?? 0) > 0 ||
    (item.sendState !== "waiting-reconnect" && typeof item.sendSubmittedAtMs === "number")
  );
}

export function isQueuedSendInlineState(item: ChatQueueItem): boolean {
  return (
    queuedSendStarted(item) &&
    !item.localCommandName &&
    (item.sendState === "failed" ||
      item.sendState === "unconfirmed" ||
      item.sendState === "held" ||
      item.sendState === "waiting-reconnect" ||
      (item.sendState === "waiting-idle" && Boolean(item.sendError)))
  );
}

export function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  // Page-local submit timing is not persisted; durable attempts keep restored prompts visible.
  return (
    queuedSendStarted(item) &&
    (item.sendState === "waiting-model" ||
      item.sendState === "submitting" ||
      item.sendState === "sending" ||
      isQueuedSendInlineState(item))
  );
}

/** An accepted input the transcript has not committed yet still owns the next turn. */
export function pendingInputHoldsTurn(
  inputs: readonly { state: string; runId?: string }[],
): boolean {
  return inputs.some((input) => input.state === "queued" && Boolean(input.runId));
}

/**
 * Sends the Gateway holds behind another turn, keyed by queue id. A shown input
 * keeps its order, so each stays in the tray, in send order, until its own turn
 * starts; only the next turn's send may enter the transcript. `queue` is in
 * delivery order; accepted Gateway inputs ahead of it set `queuedAhead`.
 */
export function queuedSendsAwaitingTurn(
  queue: readonly (ChatQueueItem & { serverQueued?: true })[],
  activeRunId: string | null | undefined,
  queuedAhead = false,
): Set<string> {
  const awaiting = new Set<string>();
  let blocked = queuedAhead;
  for (const item of queue) {
    if (
      item.queueMode === "steer" ||
      item.queueMode === "interrupt" ||
      item.sendState === "failed" ||
      isQueuedSendInlineState(item) ||
      // A row joined to an existing run is not a future turn.
      (item.pendingRunId && !item.serverQueued)
    ) {
      continue;
    }
    const inFlight =
      (item.sendState === "submitting" || item.sendState === "sending") &&
      shouldRenderQueuedSendInThread(item);
    if (inFlight && !(item.sendRunId && item.sendRunId === activeRunId)) {
      // Another run owns the session, or an earlier input still waits for its turn.
      if (blocked || activeRunId) {
        awaiting.add(item.id);
      }
    }
    blocked = true;
  }
  return awaiting;
}

// Sends a pane's transcript has shown, per pane and session. A shown input
// keeps its place even if a later run is adopted before its row retires.
const placedQueuedSends = new Map<string, Set<string>>();

export function resetPlacedQueuedSends(paneId?: string): void {
  if (!paneId) {
    placedQueuedSends.clear();
    return;
  }
  for (const key of placedQueuedSends.keys()) {
    if (key.startsWith(`${paneId}\n`)) {
      placedQueuedSends.delete(key);
    }
  }
}

/**
 * queuedSendsAwaitingTurn for one pane's transcript and tray, which must call it
 * with the same inputs: a send the transcript already shows never returns to
 * the tray. Retired rows leave the record.
 */
export function resolveQueuedSendsAwaitingTurn(
  scope: { paneId: string; sessionKey: string },
  queue: readonly (ChatQueueItem & { serverQueued?: true })[],
  activeRunId: string | null | undefined,
  queuedAhead = false,
): Set<string> {
  const key = `${scope.paneId}\n${scope.sessionKey}`;
  const placed = placedQueuedSends.get(key) ?? new Set<string>();
  const current = new Set(queue.map((item) => item.id));
  for (const id of placed) {
    if (!current.has(id)) {
      placed.delete(id);
    }
  }
  const awaiting = queuedSendsAwaitingTurn(queue, activeRunId, queuedAhead);
  for (const item of queue) {
    if (awaiting.has(item.id)) {
      if (placed.has(item.id)) {
        awaiting.delete(item.id);
      }
    } else if (
      !item.serverQueued &&
      (item.sendState === "submitting" || item.sendState === "sending") &&
      shouldRenderQueuedSendInThread(item)
    ) {
      placed.add(item.id);
    }
  }
  if (placed.size > 0) {
    placedQueuedSends.set(key, placed);
  } else {
    placedQueuedSends.delete(key);
  }
  return awaiting;
}

export function resolveWorkingProgress(
  sessionKey: string,
  runId: string | null,
  streamStartedAt: number | null,
  queue: ChatQueueItem[],
  streamSegments: Array<{ ts: number; runId?: string }>,
  toolMessages: unknown[],
): WorkingProgress {
  const visibleSends = queue.filter(shouldRenderQueuedSendInThread);
  const pendingSends = visibleSends.filter((item) => !isQueuedSendInlineState(item));
  const queuedProgress =
    pendingSends.find((item) => item.sendState === "submitting" || item.sendState === "sending") ??
    pendingSends[0];
  const queuedRunId = queuedProgress?.sendRunId ?? queuedProgress?.pendingRunId;
  const segmentRunId = streamSegments
    .map((segment) => segment.runId)
    .findLast(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  const toolProgress = toolMessages.map(asRecord);
  const toolRunId = toolProgress
    .map((message) => message?.runId)
    .findLast(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  // A submitted send owns the acknowledgment gap; delayed activity from an
  // earlier run must not claim it. Future queued sends remain a fallback.
  const submittedRunId =
    queuedProgress?.sendState === "submitting" || queuedProgress?.sendState === "sending"
      ? queuedRunId
      : undefined;
  const explicitRunId = runId ?? submittedRunId ?? segmentRunId ?? toolRunId ?? queuedRunId;
  const cached = workingProgressBySession.get(sessionKey);
  const compatibleCached =
    cached && (!explicitRunId || !cached.runId || cached.runId === explicitRunId) ? cached : null;
  const candidates = [
    compatibleCached?.startedAt,
    streamStartedAt,
    // Recovery rows cannot identify work, but matching durable timing survives reconnects.
    ...visibleSends
      .filter((item) =>
        explicitRunId
          ? (item.sendRunId ?? item.pendingRunId) === explicitRunId
          : item === queuedProgress,
      )
      // Send performance fields use performance.now(); the elapsed timer renders against Date.now().
      .map((item) => item.createdAt),
    ...streamSegments
      .filter((segment) => !explicitRunId || segment.runId === explicitRunId)
      .map((segment) => segment.ts),
    ...toolProgress
      .filter((message) => !explicitRunId || message?.runId === explicitRunId)
      .map((message) => message?.["__openclawToolStreamReceivedAt"]),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startedAt = candidates.length > 0 ? Math.min(...candidates) : Date.now();
  const key =
    compatibleCached?.key ??
    `stream-working:${JSON.stringify([
      sessionKey,
      explicitRunId ?? `anonymous-${++anonymousWorkingProgressId}`,
    ])}`;
  workingProgressBySession.set(sessionKey, {
    key,
    runId: explicitRunId ?? compatibleCached?.runId ?? null,
    startedAt,
  });
  return { key, runId: explicitRunId ?? compatibleCached?.runId ?? null, startedAt };
}

export function clearWorkingProgress(sessionKey: string): void {
  workingProgressBySession.delete(sessionKey);
}

export function resetWorkingProgress(): void {
  workingProgressBySession.clear();
  anonymousWorkingProgressId = 0;
}

export type TurnRecap = { runtimeMs: number; outputTokens: number | null };

// The pane owns one watched run. Session-wide usage is a different fact and
// may still describe the previous response when the terminal row arrives.
export type TurnRecapWatch = {
  sessionKey: string;
  agentId: string | null;
  gatewayClient: GatewayBrowserClient | null;
  runId: string;
  /** For a run that resumed a handoff: when its request was asked and the runs before it. */
  request: TurnRequest | null;
  recap: TurnRecap | null;
};

type TurnRequest = { askedAt: number; runIds: readonly string[] };

/** Output tokens across the runs of one answer; null unless every run has reported. */
export function sumRunOutputTokens(
  usageByRun: ReadonlyMap<string, RunOutputUsage> | undefined,
  runIds: readonly string[],
): number | null {
  let total = 0;
  for (const runId of runIds) {
    const usage = usageByRun?.get(runId);
    if (!usage) {
      return null;
    }
    total += usage.outputTokens;
  }
  return runIds.length > 0 ? total : null;
}

export function resolveTurnRecap(
  host: { turnRecapWatch: TurnRecapWatch | null },
  params: {
    sessionKey: string;
    agentId?: string | null;
    gatewayClient?: GatewayBrowserClient | null;
    indicator?: { runId?: string; request?: TurnRequest };
    row?: Pick<GatewaySessionRow, "lastRunId" | "status" | "runtimeMs" | "endedAt">;
    usageByRun?: ReadonlyMap<string, RunOutputUsage>;
  },
): (TurnRecap & { runId: string }) | null {
  const { sessionKey, agentId = null, gatewayClient = null, indicator, row, usageByRun } = params;
  let watch = host.turnRecapWatch;
  if (
    watch?.sessionKey !== sessionKey ||
    watch.agentId !== agentId ||
    watch.gatewayClient !== gatewayClient
  ) {
    watch = null;
  }
  if (indicator) {
    const runId = indicator.runId;
    if (!runId) {
      host.turnRecapWatch = null;
      return null;
    }
    if (watch?.runId !== runId) {
      watch = { sessionKey, agentId, gatewayClient, runId, request: null, recap: null };
    }
    watch.request = indicator.request ?? null;
  }
  host.turnRecapWatch = watch;
  if (!watch) {
    return null;
  }
  const outputTokens =
    sumRunOutputTokens(usageByRun, [...(watch.request?.runIds ?? []), watch.runId]) ??
    watch.recap?.outputTokens ??
    null;
  if (row?.lastRunId === watch.runId) {
    const runtimeMs = row.runtimeMs;
    if (row.status === "done" && typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) {
      // A resumed answer reports the whole request, the wait included. Both
      // ends are on the Gateway's clock; it never reports less than its last run.
      const sinceRequest =
        watch.request && typeof row.endedAt === "number" ? row.endedAt - watch.request.askedAt : 0;
      watch.recap = { runtimeMs: Math.max(runtimeMs, sinceRequest), outputTokens };
    } else if (row.status && row.status !== "done") {
      watch.recap = null;
    }
  }
  // Usage can arrive after terminal presentation. Keep accepting facts for
  // this exact run without borrowing another run's session-row counters.
  if (watch.recap && watch.recap.outputTokens !== outputTokens) {
    watch.recap = { ...watch.recap, outputTokens };
  }
  return indicator || !watch.recap ? null : { ...watch.recap, runId: watch.runId };
}
