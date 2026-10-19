import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { decodeSessionPromotion } from "../../sessions/session-promotion-state.js";
import {
  activatePendingSessionPromotion,
  revokePendingSessionPromotion,
} from "../../sessions/session-promotion.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { UserProfileNotFoundError } from "../../state/user-profiles-schema.js";
import { GitHubPublicationRequesterUnavailableError } from "../github-publication-failure.js";
import {
  captureGitHubPublicationRequester,
  restoreGitHubPublicationRequester,
} from "../github-publication-requester.js";
import { GatewayOperatorAccessUnavailableError } from "../operator-access-policy.js";
import { prepareGatewaySessionAccessAuthority } from "../session-access-authority.js";
import { isControlUiAdminClient } from "../session-promotion-client.js";
import {
  prepareFreshHumanPromotionRequester,
  promotionDeviceGeneration,
  PromotionRequesterDeniedError,
  readPromotionPairedDevice,
} from "../session-promotion-human.js";
import { createSessionPromotionOwnerCheck } from "../session-promotion-owner-check.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { probeSessionEntryObligations } from "./sessions-promotion-entry-obligations.js";
import { probeSessionPromotionQuiescence } from "./sessions-promotion-quiescence.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

type ActivationOptions = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "sessionMutationAuthorization" | "hasCurrentClientAuthority"
>;

export type SessionPromotionAdmissionOutcome = "unchanged" | "activated" | "revoked";

type Restored = Awaited<ReturnType<typeof restoreGitHubPublicationRequester>>;

/**
 * Shared activation helper behind BOTH entrypoints. It never invents authority:
 * - fresh human (`human` supplied): the same recorded human must be the live authenticated
 *   Control UI caller. If the original accepted basis cannot be proved after a restart, that
 *   exact caller may rebind it (recorded); a provably ended basis is terminal.
 * - owner settlement (no `human`): only the restored ORIGINAL accepted basis may proceed; an
 *   unprovable basis stays pending until a fresh same-human admission. No human is synthesized.
 * Owners report quiescence before the lifecycle fence; the commit re-reads them synchronously,
 * rejects any admission reserved meanwhile and re-asserts all authority.
 */
async function consumePendingPromotion(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentIdOverride?: string;
  signal?: AbortSignal;
  freshHuman?: ActivationOptions;
}): Promise<SessionPromotionAdmissionOutcome> {
  const { context } = params;
  const cfg = context.getRuntimeConfig();
  const owner = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentIdOverride);
  if (!owner.ok) {
    return "unchanged";
  }
  const scope = { cfg, agentId: owner.agentId, sessionKey: params.sessionKey };
  const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
  const entry = target.entry;
  const pending = decodeSessionPromotion(entry?.sessionPromotion);
  if (
    !entry ||
    pending?.state !== "pending" ||
    pending.target.key !== target.canonicalKey ||
    pending.target.sessionId !== entry.sessionId ||
    pending.target.fromLifecycleRevision !== entry.lifecycleRevision ||
    pending.requester.actor.kind !== "operator"
  ) {
    return "unchanged";
  }
  let human: ReturnType<typeof prepareFreshHumanPromotionRequester> | undefined;
  if (params.freshHuman) {
    try {
      human = prepareFreshHumanPromotionRequester(params.freshHuman);
    } catch (error) {
      if (error instanceof PromotionRequesterDeniedError) {
        return "unchanged";
      }
      throw error;
    }
    if (human.profileId !== pending.requester.actor.profileId) {
      // Another person's input is not the recorded human's fresh admission.
      return "unchanged";
    }
  }
  const aliases = [
    ...new Set([params.sessionKey, target.canonicalKey, target.storeKey, ...target.storeKeys]),
  ];
  const probeOwners = (
    options: Pick<Parameters<typeof probeSessionPromotionQuiescence>[0], "quick" | "watch">,
  ) =>
    probeSessionPromotionQuiescence({
      context,
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      sessionKeys: aliases,
      sessionId: entry.sessionId,
      agentId: owner.agentId,
      lifecycleIdentities: [...aliases, entry.sessionId],
      ...options,
    });
  // Advisory and read-only: every chat attempt and owner release lands here. Skip the identity
  // and grant restores below while the session is visibly busy.
  if (
    probeSessionEntryObligations(entry).length > 0 ||
    (await probeOwners({ quick: true })).blockers.length > 0
  ) {
    return "unchanged";
  }
  // The original device incarnation ending (unpaired, or paired again / re-keyed since) is a
  // provable ending of the accepted basis. An unreadable pairing store proves nothing: stay
  // pending, never revoke.
  const { deviceId, deviceGeneration } = pending;
  const readOriginalDevice = async (id: string) =>
    await readPromotionPairedDevice(id).then(
      (record) =>
        !record
          ? ("original-device-unpaired" as const)
          : promotionDeviceGeneration(record) !== deviceGeneration
            ? ("original-device-repaired" as const)
            : ("paired" as const),
      () => "unknown" as const,
    );
  if (deviceId) {
    const device = await readOriginalDevice(deviceId);
    if (device === "unknown") {
      return "unchanged";
    }
    if (device !== "paired") {
      await revokePendingSessionPromotion({
        scope,
        expectedSessionId: entry.sessionId,
        expectedLifecycleRevision: pending.target.fromLifecycleRevision,
        requestId: pending.requestId,
        reason: device,
        signal: params.signal,
      });
      return "revoked";
    }
  }
  // The same ownership rule the request and the viewer projection use. The restored original
  // basis has no connection: its admin scopes, re-proved against the current role, decide.
  const sessionRef = {
    sessionKey: params.sessionKey,
    agentId: owner.agentId,
    authorizeOwner: createSessionPromotionOwnerCheck(context, params.sessionKey),
  };
  const releases: Array<() => void> = [];
  try {
    let access:
      | Awaited<ReturnType<typeof prepareGatewaySessionAccessAuthority>>["authority"]
      | undefined;
    let fresh: Awaited<ReturnType<typeof captureGitHubPublicationRequester>> | undefined;
    if (human && params.freshHuman) {
      const humanOptions = params.freshHuman;
      const assertHuman = human.assertCurrent;
      const preparedAccess = await prepareGatewaySessionAccessAuthority({
        policy: { mode: "write" },
        requestParams: { sessionKey: params.sessionKey },
        client: humanOptions.client,
        context,
        // Ownership is the promotion rule the requester policies below enforce.
        ownSessionOnly: false,
        assertInvocationCurrent: assertHuman,
        hasCurrentClientAuthority: () => {
          assertHuman();
          return true;
        },
      });
      access = preparedAccess.authority;
      releases.push(access.release);
      preparedAccess.assertPreparationCurrent();
      fresh = await captureGitHubPublicationRequester(
        {
          client: humanOptions.client,
          context,
          signal: humanOptions.signal,
          sessionMutationAuthorization: humanOptions.sessionMutationAuthorization,
          hasCurrentClientAuthority: () => {
            assertHuman();
            return true;
          },
        } as Parameters<typeof captureGitHubPublicationRequester>[0],
        {
          ...sessionRef,
          // A live admission also needs the live, host-attested Control UI admin flag.
          authorizeOwner: createSessionPromotionOwnerCheck(context, params.sessionKey, () =>
            isControlUiAdminClient(humanOptions.client),
          ),
        },
      );
      releases.push(fresh.release);
    }
    let original: Restored | undefined;
    let basis: "original-basis" | "fresh-human-rebound" = "original-basis";
    try {
      original = await restoreGitHubPublicationRequester(
        JSON.stringify(pending.requester),
        sessionRef,
        context.getCommittedRuntimeConfig ?? context.getRuntimeConfig,
      );
      releases.push(original.release);
    } catch (error) {
      if (error instanceof GatewayOperatorAccessUnavailableError) {
        // The original grant cannot be proved (for example after a restart). Only the SAME human
        // admitted right now may rebind it, and the original scope ceiling must still allow it.
        if (
          !human ||
          !roleScopesAllow({
            role: "operator",
            requestedScopes: ["operator.sessions.write"],
            allowedScopes: pending.requester.scopes,
          })
        ) {
          return "unchanged";
        }
        basis = "fresh-human-rebound";
      } else if (
        error instanceof GitHubPublicationRequesterUnavailableError &&
        error.cause !== undefined &&
        !(error.cause instanceof UserProfileNotFoundError)
      ) {
        // An identity read failed without proving the basis ended: stay pending, never revoke.
        return "unchanged";
      } else if (error instanceof GitHubPublicationRequesterUnavailableError) {
        // Provably ended (revoked grant, role downgrade, merged identity): terminal, never revived.
        await revokePendingSessionPromotion({
          scope,
          expectedSessionId: entry.sessionId,
          expectedLifecycleRevision: pending.target.fromLifecycleRevision,
          requestId: pending.requestId,
          reason: "original-basis-ended",
          signal: params.signal,
        });
        return "revoked";
      } else {
        // Profile or session storage unavailable: stay pending, honestly not active.
        return "unchanged";
      }
    }
    const assertCurrent = () => {
      human?.assertCurrent();
      access?.assertCurrent();
      fresh?.requester.assertCurrent();
      original?.assertCurrent();
    };
    assertCurrent();
    let recheckOwners: (() => Array<{ code: string }>) | undefined;
    const result = await activatePendingSessionPromotion({
      scope,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: pending.target.fromLifecycleRevision,
      requestId: pending.requestId,
      basis,
      signal: params.signal,
      assertCurrent,
      // The authoritative owner reads await, so they run before the fence and the writer...
      probeBlockers: async (watch) => {
        const probe = await probeOwners({ quick: false, watch });
        recheckOwners = probe.recheck;
        const blockers = probe.blockers.map((blocker) => blocker.code);
        // The pairing read is asynchronous, so it cannot join the synchronous commit recheck;
        // re-read it after the probe's awaits instead. Any change only declines this commit:
        // the next attempt's pre-check above owns the terminal revocation.
        if (deviceId && (await readOriginalDevice(deviceId)) !== "paired") {
          blockers.push("original-device-unverified");
        }
        return blockers;
      },
      // ...and are read again synchronously on the locked row, right before the write.
      recheckBlockers: (lockedEntry) => [
        ...(recheckOwners?.() ?? [{ code: "inventory-unavailable" }]).map(
          (blocker) => blocker.code,
        ),
        ...probeSessionEntryObligations(lockedEntry).map((blocker) => blocker.code),
      ],
    });
    return result.activated ? "activated" : "unchanged";
  } finally {
    for (const release of releases.toReversed()) {
      release();
    }
  }
}

/** Entrypoint (b): the next freshly authenticated human admission, BEFORE its lease/snapshot. */
export async function activateSessionPromotionBeforeAdmission(params: {
  options: ActivationOptions;
  sessionKey: string;
  agentIdOverride?: string;
}): Promise<SessionPromotionAdmissionOutcome> {
  return await consumePendingPromotion({
    context: params.options.context,
    sessionKey: params.sessionKey,
    agentIdOverride: params.agentIdOverride,
    signal: params.options.signal,
    freshHuman: params.options,
  });
}

/** Entrypoint (a): an owner released its work; consume only the already-persisted intent. */
export async function activateSessionPromotionAfterSettlement(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  signal?: AbortSignal;
}): Promise<SessionPromotionAdmissionOutcome> {
  return await consumePendingPromotion(params);
}
