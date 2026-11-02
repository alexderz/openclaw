import type { SessionActor } from "./session-entry-provenance.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type RestartTombstoneRecoveryResult =
  | {
      /** `rolled`: a main session continued on a new session id under its own key. */
      status: "created" | "existing" | "rolled";
      sourceEntry: SessionEntry;
      successorEntry: SessionEntry;
      successorKey: string;
    }
  | {
      status: "conflict";
      reason:
        | "not-tombstoned"
        | "source-changed"
        | "successor-missing"
        | "target-exists"
        | "transcript-missing";
    };

export type RestartTombstoneRecoveryParams = {
  agentId: string;
  archivedBy?: SessionActor;
  expected: {
    cycleId: string;
    lifecycleRevision?: string;
    pluginOwnerId?: string;
    revision: number;
    sessionId: string;
  };
  commitGuard?: () => void;
  /**
   * Roll the source row itself onto `successorEntry` instead of archiving it behind a
   * separate successor row. Main sessions use this so they are never replaced by a leaf;
   * an earlier linked successor is ignored and left untouched.
   */
  inPlace?: true;
  sourceTarget: { canonicalKey: string; storeKeys: readonly string[] };
  storePath: string;
  successorEntry: InternalSessionEntry & { sessionId: string };
  successorTarget: { canonicalKey: string; storeKeys: readonly string[] };
};

export type RestartTombstoneRecoveryInput = Omit<
  RestartTombstoneRecoveryParams,
  "commitGuard" | "storePath"
>;
