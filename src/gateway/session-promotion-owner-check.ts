import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAdminPromotionScopes } from "../sessions/session-promotion-state.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import {
  resolveSessionPromotionOwnership,
  type SessionPromotionLineageEntry,
  type SessionPromotionOwnership,
  type SessionPromotionOwnershipDenial,
} from "./session-promotion-ownership.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** A proven ownership denial: terminal for a stored intent, FORBIDDEN for a request. */
export class SessionPromotionOwnershipDeniedError extends GitHubPublicationRequesterUnavailableError {
  constructor(readonly reason: SessionPromotionOwnershipDenial) {
    super();
  }
}

/** The chain could not be read: a stored intent stays pending, a request is refused. */
export class SessionPromotionLineageUnavailableError extends GitHubPublicationRecoveryPendingError {
  readonly reason = "lineage-unreadable" as const;
  constructor() {
    super("Session promotion lineage is unavailable; retry after session storage is ready.");
  }
}

/** Requester-policy adapter: throws the error the durable requester owners already classify. */
export function assertSessionPromotionOwnership(ownership: SessionPromotionOwnership): void {
  if (ownership.ok) {
    return;
  }
  if (ownership.reason === "lineage-unreadable") {
    throw new SessionPromotionLineageUnavailableError();
  }
  throw new SessionPromotionOwnershipDeniedError(ownership.reason);
}

/**
 * The durable requester's owner check for one promotion target. Lineage hops are read from the
 * resident session-row projection (each hop from its own agent store), never by main-thread SQL.
 *
 * Admin is the requester's immutable scopes, which the requester owner re-proves against the
 * current role on every check, plus `liveAdmin` when a live connection is present (request and
 * fresh-human activation). A restored intent has no connection: its original admin scopes,
 * still granted by the current role, are the basis; a revoked admin grant ends it.
 */
export function createSessionPromotionOwnerCheck(
  context: Pick<GatewayRequestContext, "sessionRowProjectionOwner">,
  sessionKey: string,
  liveAdmin?: () => boolean,
) {
  return (owner: {
    config: OpenClawConfig;
    profileId: string;
    aliases: ReadonlySet<string>;
    scopes: readonly string[];
    entry: SessionPromotionLineageEntry;
  }) =>
    assertSessionPromotionOwnership(
      resolveSessionPromotionOwnership({
        admin: isAdminPromotionScopes(owner.scopes) && (liveAdmin?.() ?? true),
        cfg: owner.config,
        profileId: owner.profileId,
        scopes: owner.scopes,
        isCreator: prepareSessionCreatorProfile(owner.profileId, owner.aliases),
        target: { canonicalKey: sessionKey, entry: owner.entry },
        readEntry: (query) => {
          const projection = getSessionRowProjection(context);
          if (!projection) {
            throw new Error("Session row projection is unavailable");
          }
          return projection.sharingTarget(query)?.entry;
        },
      }),
    );
}
