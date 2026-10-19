import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

export type SessionPromotionLineageEntry = Pick<SessionEntry, "createdActor" | "parentSessionKey">;

/** Delegation trees are shallow; a longer chain is treated as unprovable, never as owned. */
export const SESSION_PROMOTION_LINEAGE_MAX_HOPS = 32;

export type SessionPromotionOwnershipDenial =
  | "scope-denied"
  | "not-admin-not-owner"
  | "lineage-denied"
  | "lineage-unreadable";

export type SessionPromotionOwnership =
  | { ok: true; basis: "admin" | "own-session" | "lineage-own-root" | "lineage-agent-main" }
  | { ok: false; reason: SessionPromotionOwnershipDenial };

/**
 * The one promotion ownership rule, shared by the request handler, both activation entrypoints
 * and the viewer projection. A person may promote:
 * - any session, as an administrator (the caller attests admin for its context: the live
 *   Control UI admin flag at ingress, the re-proved original admin scopes at restore); or
 * - their own session, under the existing creator predicate; or
 * - an agent-created session whose parentSessionKey chain, walked hop by hop through each
 *   hop's own agent store, first reaches a session that is not agent-created and that is
 *   either their own session or an agent's main session while they are the gateway owner.
 * Unknown, unreadable, cyclic or over-long chains deny. Sharing, role, agent access, sandbox,
 * supported-target and live-human checks stay with their owners; this rule never widens them.
 */
export function resolveSessionPromotionOwnership(params: {
  admin: boolean;
  cfg: OpenClawConfig;
  profileId: string;
  scopes: readonly string[];
  isCreator: (actor: SessionEntry["createdActor"]) => boolean;
  target: { canonicalKey: string; entry: SessionPromotionLineageEntry };
  /** Reads one hop from its own agent's store; missing or throwing means unknown. */
  readEntry: (query: {
    agentId: string;
    key: string;
  }) => SessionPromotionLineageEntry | null | undefined;
}): SessionPromotionOwnership {
  if (
    !params.profileId.trim() ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.sessions.write"],
      allowedScopes: params.scopes,
    })
  ) {
    return { ok: false, reason: "scope-denied" };
  }
  if (params.admin) {
    return { ok: true, basis: "admin" };
  }
  if (params.isCreator(params.target.entry.createdActor)) {
    return { ok: true, basis: "own-session" };
  }
  if (params.target.entry.createdActor?.type !== "agent") {
    return { ok: false, reason: "not-admin-not-owner" };
  }
  const visited = new Set([params.target.canonicalKey]);
  let current = params.target.entry;
  for (let hop = 0; hop < SESSION_PROMOTION_LINEAGE_MAX_HOPS; hop += 1) {
    const key = current.parentSessionKey;
    const parsed = key ? parseAgentSessionKey(key) : null;
    if (!key || !parsed || key !== key.trim() || visited.has(key)) {
      return { ok: false, reason: "lineage-unreadable" };
    }
    visited.add(key);
    let entry: SessionPromotionLineageEntry | null | undefined;
    try {
      entry = params.readEntry({ agentId: parsed.agentId, key });
    } catch {
      entry = undefined;
    }
    if (!entry) {
      return { ok: false, reason: "lineage-unreadable" };
    }
    if (entry.createdActor?.type === "agent") {
      current = entry;
      continue;
    }
    if (params.isCreator(entry.createdActor)) {
      return { ok: true, basis: "lineage-own-root" };
    }
    return entry.createdActor?.type !== "human" &&
      params.profileId === GATEWAY_OWNER_PROFILE_ID &&
      key === resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parsed.agentId })
      ? { ok: true, basis: "lineage-agent-main" }
      : { ok: false, reason: "lineage-denied" };
  }
  return { ok: false, reason: "lineage-unreadable" };
}
