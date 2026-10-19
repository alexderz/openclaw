import { z } from "zod";
import { isAcpSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";

/** Core-owned intent, never accepted from a session patch, plugin, import or model. */
const boundedId = z.string().min(1).max(128);
const targetSchema = z.strictObject({
  agentId: boundedId,
  key: z.string().min(1).max(2048),
  sessionId: boundedId,
  fromLifecycleRevision: boundedId,
});
const requesterSchema = z
  .unknown()
  .transform((value, context): GitHubPublicationRequesterSnapshot => {
    const snapshot = decodeGitHubPublicationRequester(JSON.stringify(value));
    if (!snapshot || snapshot.actor.kind !== "operator") {
      context.addIssue({ code: "custom", message: "human requester required" });
      return z.NEVER;
    }
    return snapshot;
  });
const base = {
  version: z.literal(1),
  requestId: boundedId,
  acceptedAt: z.number().finite().nonnegative(),
  target: targetSchema,
  boundary: z.literal("settlement-or-fresh-human-input"),
};
const pendingSchema = z.strictObject({
  ...base,
  state: z.literal("pending"),
  requester: requesterSchema,
  /**
   * Control UI device observed as paired when the intent was accepted, with its pairing
   * incarnation. A later unpair, re-pair or re-key is a provable ending of the original basis.
   * Both are absent when the caller presented no device or the device was not paired.
   */
  deviceId: boundedId.optional(),
  deviceGeneration: boundedId.optional(),
});
const audit = { profileId: boundedId };
const AGENT_SESSION_KEY = /^agent:[^:]+:[^:].*$/;
const DASHBOARD_SESSION_KEY = /^agent:[^:]+:dashboard:[^:]+$/;
const terminalBase = { ...base, ...audit };
const promotionSchema = z
  .discriminatedUnion("state", [
    pendingSchema,
    z.strictObject({
      ...terminalBase,
      state: z.literal("activated"),
      /** original-basis: restored accepted grant; fresh-human-rebound: same human re-admitted after restart. */
      basis: z.enum(["original-basis", "fresh-human-rebound"]).optional(),
      toLifecycleRevision: boundedId,
      activatedAt: z.number().finite().nonnegative(),
    }),
    z.strictObject({
      ...terminalBase,
      state: z.literal("cancelled"),
      settledAt: z.number().finite().nonnegative(),
    }),
    z.strictObject({
      ...terminalBase,
      state: z.literal("revoked"),
      settledAt: z.number().finite().nonnegative(),
      reason: boundedId,
    }),
    z.strictObject({
      ...terminalBase,
      state: z.literal("blocked"),
      settledAt: z.number().finite().nonnegative(),
      reason: boundedId,
    }),
  ])
  .superRefine((record, context) => {
    // Data validation only: which requester may target which key family is assertTarget's rule.
    if (
      !record.target.key.startsWith("agent:" + record.target.agentId + ":") ||
      !AGENT_SESSION_KEY.test(record.target.key) ||
      isIncognitoSessionKey(record.target.key)
    ) {
      context.addIssue({ code: "custom", message: "unsupported promotion target" });
    }
    if (
      record.state === "activated" &&
      (record.toLifecycleRevision === record.target.fromLifecycleRevision ||
        record.activatedAt < record.acceptedAt)
    ) {
      context.addIssue({ code: "custom", message: "invalid activation boundary" });
    }
    if (
      record.state === "pending" &&
      Boolean(record.deviceId) !== Boolean(record.deviceGeneration)
    ) {
      context.addIssue({ code: "custom", message: "device binding requires its incarnation" });
    }
    if ("settledAt" in record && record.settledAt < record.acceptedAt) {
      context.addIssue({ code: "custom", message: "invalid settlement boundary" });
    }
  });
export type SessionPromotion = z.infer<typeof promotionSchema>;
export type PendingSessionPromotion = Extract<SessionPromotion, { state: "pending" }>;
export type SessionPromotionTarget = z.infer<typeof targetSchema>;

/** Validation is data validation only: no receipt is a bearer capability. */
export function decodeSessionPromotion(value: unknown): SessionPromotion | undefined {
  try {
    const result = promotionSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export class SessionPromotionConflictError extends Error {
  constructor() {
    super("Session promotion target or request changed.");
  }
}
export type SessionPromotionUnsupportedReason =
  | "unsupported-key"
  | "incognito"
  | "acp-session"
  | "not-delegated"
  | "dashboard-only"
  | "requester-not-human";
export class SessionPromotionUnsupportedError extends Error {
  constructor(readonly reason: SessionPromotionUnsupportedReason = "unsupported-key") {
    super("Session promotion is not available for this target.");
  }
}

/**
 * An administrator's accepted basis: operator.admin in the immutable requester scopes. Live
 * ingress additionally requires the host-attested Control UI admin flag; restore re-proves the
 * scopes against the current role, so a revoked admin grant ends the intent.
 */
export function isAdminPromotionScopes(scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role: "operator",
    requestedScopes: ["operator.admin"],
    allowedScopes: scopes,
  });
}

type PromotionEntry = Pick<
  import("../config/sessions/types.js").SessionEntry,
  | "sessionId"
  | "lifecycleRevision"
  | "sessionPromotion"
  | "spawnedBy"
  | "spawnDepth"
  | "visibility"
  | "incognito"
>;

/**
 * The one supported-target rule. Administrators may promote any durable delegated session key
 * (dashboard, subagent/task, cron-backed and other agent-scoped rows); everyone else keeps the
 * durable dashboard conversation. Incognito is a privacy boundary for everyone. ACP sessions run
 * an external harness that the admitted ordinary class does not govern, and a never-delegated
 * row has nothing to promote. Rows that do not exist are refused before this by access checks.
 */
export function resolveSessionPromotionTargetSupport(
  key: string,
  entry: PromotionEntry,
  requester: { admin: boolean },
): SessionPromotionUnsupportedReason | null {
  if (!AGENT_SESSION_KEY.test(key)) {
    return "unsupported-key";
  }
  // Process-only conversations have no durable identity to hand over.
  if (isIncognitoSessionKey(key) || entry.incognito === true) {
    return "incognito";
  }
  if (isAcpSessionKey(key)) {
    return "acp-session";
  }
  if (!entry.spawnedBy && !((entry.spawnDepth ?? 0) > 0)) {
    return "not-delegated";
  }
  return requester.admin || DASHBOARD_SESSION_KEY.test(key) ? null : "dashboard-only";
}
function assertTarget(
  entry: PromotionEntry,
  target: SessionPromotionTarget,
  requester: GitHubPublicationRequesterSnapshot,
): void {
  if (
    entry.sessionId !== target.sessionId ||
    entry.lifecycleRevision !== target.fromLifecycleRevision
  ) {
    throw new SessionPromotionConflictError();
  }
  const unsupported = resolveSessionPromotionTargetSupport(target.key, entry, {
    admin: isAdminPromotionScopes(requester.scopes),
  });
  if (unsupported) {
    throw new SessionPromotionUnsupportedError(unsupported);
  }
}
function sameTarget(a: SessionPromotionTarget, b: SessionPromotionTarget): boolean {
  return (
    a.agentId === b.agentId &&
    a.key === b.key &&
    a.sessionId === b.sessionId &&
    a.fromLifecycleRevision === b.fromLifecycleRevision
  );
}
function auditOf(pending: PendingSessionPromotion) {
  if (pending.requester.actor.kind !== "operator") {
    throw new SessionPromotionUnsupportedError("requester-not-human");
  }
  return {
    version: pending.version,
    requestId: pending.requestId,
    acceptedAt: pending.acceptedAt,
    target: pending.target,
    boundary: pending.boundary,
    profileId: pending.requester.actor.profileId,
  };
}

/** Called only inside the lifecycle identity fence AND the authoritative store writer. */
export function applySessionPromotionRequest(params: {
  entry: PromotionEntry;
  target: SessionPromotionTarget;
  requester: GitHubPublicationRequesterSnapshot;
  requestId: string;
  action?: "request" | "cancel";
  /** Device the caller connected with and its pairing incarnation, read by the Gateway handler. */
  device?: { id: string; generation: string };
  now: number;
  /** Prepared current human role, grant, own-target and agent checks, plus invocation custody. */
  assertCurrent: () => void;
}): SessionPromotion {
  params.assertCurrent(); // Always before even an idempotent response.
  const existing = decodeSessionPromotion(params.entry.sessionPromotion);
  // An activated receipt is bound to the new revision, not the original request revision.
  if (existing?.state === "activated") {
    if (
      params.entry.sessionId !== existing.target.sessionId ||
      params.entry.lifecycleRevision !== existing.toLifecycleRevision ||
      params.target.sessionId !== params.entry.sessionId ||
      params.target.key !== existing.target.key ||
      params.target.agentId !== existing.target.agentId ||
      params.target.fromLifecycleRevision !== params.entry.lifecycleRevision
    ) {
      throw new SessionPromotionConflictError();
    }
    return existing;
  }
  assertTarget(params.entry, params.target, params.requester);
  if (existing && !sameTarget(existing.target, params.target)) {
    throw new SessionPromotionConflictError();
  }
  if (existing?.requestId === params.requestId) {
    if (existing.state !== "pending" || params.action !== "cancel") {
      return existing;
    }
    const cancelled: SessionPromotion = {
      ...auditOf(existing),
      state: "cancelled",
      settledAt: params.now,
    };
    params.entry.sessionPromotion = cancelled;
    return cancelled;
  }
  if (existing?.state === "pending" || params.action === "cancel") {
    throw new SessionPromotionConflictError();
  }
  const intent = decodeSessionPromotion({
    version: 1,
    state: "pending",
    requestId: params.requestId,
    acceptedAt: params.now,
    target: params.target,
    requester: params.requester,
    ...(params.device
      ? { deviceId: params.device.id, deviceGeneration: params.device.generation }
      : {}),
    boundary: "settlement-or-fresh-human-input",
  });
  if (!intent || intent.state !== "pending") {
    throw new SessionPromotionUnsupportedError("requester-not-human");
  }
  params.assertCurrent();
  params.entry.sessionPromotion = intent;
  return intent;
}

/** Original basis provably ended: terminal, never revived by a later regrant. */
export function revokePendingSessionPromotion(params: {
  entry: PromotionEntry;
  target: SessionPromotionTarget;
  now: number;
  reason: string;
}): boolean {
  const pending = decodeSessionPromotion(params.entry.sessionPromotion);
  if (pending?.state !== "pending") {
    return false;
  }
  assertTarget(params.entry, params.target, pending.requester);
  if (!sameTarget(pending.target, params.target)) {
    throw new SessionPromotionConflictError();
  }
  params.entry.sessionPromotion = {
    ...auditOf(pending),
    state: "revoked",
    settledAt: params.now,
    reason: params.reason,
  };
  return true;
}

/** No transport authority may reach here. The caller restores the committed original requester. */
export function activatePendingSessionPromotion(params: {
  entry: PromotionEntry;
  target: SessionPromotionTarget;
  now: number;
  nextRevision: string;
  /** Complete owner-probed quiescence result, sampled inside the same admission fence. */
  blockers: readonly string[];
  basis?: "original-basis" | "fresh-human-rebound";
  assertCurrent: () => void;
}): boolean {
  params.assertCurrent();
  const pending = decodeSessionPromotion(params.entry.sessionPromotion);
  if (pending?.state !== "pending") {
    return false;
  }
  assertTarget(params.entry, params.target, pending.requester);
  if (!sameTarget(pending.target, params.target)) {
    throw new SessionPromotionConflictError();
  }
  if (params.blockers.length > 0) {
    return false;
  }
  if (!params.nextRevision || params.nextRevision === params.target.fromLifecycleRevision) {
    throw new SessionPromotionConflictError();
  }
  params.assertCurrent();
  params.entry.sessionPromotion = {
    ...auditOf(pending),
    state: "activated",
    ...(params.basis ? { basis: params.basis } : {}),
    activatedAt: params.now,
    toLifecycleRevision: params.nextRevision,
  };
  params.entry.lifecycleRevision = params.nextRevision;
  return true;
}

/**
 * Handles minted by the activation branch below. Only these lift delegation: a structurally
 * equal object from options, a plugin, a model, a tool call or an MCP client is never one.
 */
const activatedOrdinaryAdmissions = new WeakSet<object>();

/** True only for the exact handle captured for a fresh human turn after verified activation. */
export function isActivatedOrdinarySessionEffectiveAdmission(value: unknown): boolean {
  return typeof value === "object" && value !== null && activatedOrdinaryAdmissions.has(value);
}

/** Immutable ceiling captured for ONE newly admitted run; never reread mid-run. */
export type SessionEffectiveAdmission = Readonly<{
  sessionId: string;
  lifecycleRevision: string | undefined;
  effectiveClass: "ordinary" | "delegated";
  humanProfileId?: string;
  policyCeiling?: Readonly<{ allow?: readonly string[]; deny?: readonly string[] }>;
}>;
export function captureSessionEffectiveAdmission(params: {
  entry: PromotionEntry;
  sessionKey: string;
  humanProfileId?: string;
  policyCeiling?: { allow?: readonly string[]; deny?: readonly string[] };
  /** Fresh, current human admission from the prepared authority owner, never a model continuation. */
  assertCurrent?: () => void;
  /**
   * Identity the input was prepared and queued under. A handle accepted before a handoff keeps
   * its historical class even if the row has since advanced to the activated revision.
   */
  admittedIdentity?: { sessionId?: string; lifecycleRevision?: string };
}): SessionEffectiveAdmission {
  const historicalDelegated = Boolean(params.entry.spawnedBy || (params.entry.spawnDepth ?? 0) > 0);
  const receipt = decodeSessionPromotion(params.entry.sessionPromotion);
  let effectiveClass: SessionEffectiveAdmission["effectiveClass"] = historicalDelegated
    ? "delegated"
    : "ordinary";
  // A never-delegated row reports "ordinary" for display only; it lifts nothing, so key-shape,
  // ACP-owned or legacy delegated sessions without spawn fields keep their resolver classification.
  let activated = false;
  if (
    historicalDelegated &&
    receipt?.state === "activated" &&
    receipt.target.key === params.sessionKey &&
    receipt.target.sessionId === params.entry.sessionId &&
    receipt.toLifecycleRevision === params.entry.lifecycleRevision &&
    (!params.admittedIdentity ||
      (params.admittedIdentity.sessionId === params.entry.sessionId &&
        params.admittedIdentity.lifecycleRevision === params.entry.lifecycleRevision)) &&
    params.humanProfileId === receipt.profileId &&
    params.assertCurrent &&
    params.policyCeiling
  ) {
    params.assertCurrent();
    effectiveClass = "ordinary";
    activated = true;
  }
  const admission: SessionEffectiveAdmission = Object.freeze({
    sessionId: params.entry.sessionId,
    lifecycleRevision: params.entry.lifecycleRevision,
    effectiveClass,
    ...(params.humanProfileId ? { humanProfileId: params.humanProfileId } : {}),
    ...(params.policyCeiling
      ? {
          policyCeiling: Object.freeze({
            ...(params.policyCeiling.allow
              ? { allow: Object.freeze([...params.policyCeiling.allow]) }
              : {}),
            ...(params.policyCeiling.deny
              ? { deny: Object.freeze([...params.policyCeiling.deny]) }
              : {}),
          }),
        }
      : {}),
  });
  if (activated) {
    activatedOrdinaryAdmissions.add(admission);
  }
  return admission;
}
