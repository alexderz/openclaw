import type { SessionProjectionEntry } from "./session-projection-message-identity.js";

export type SessionProjectionSnapshotOptions = {
  shouldIncludeMessage?: (message: unknown) => boolean;
  /** Native transcript sequences the snapshot lists in full. */
  authoritativeSequences?: { from: number; to: number };
};

/**
 * A settled live copy of a durable row inside a fully listed range that the
 * snapshot did not match is drift, not a newer event; pending sends and an
 * active run's rows still belong to the client.
 */
export function isSupersededLiveCopy(
  entry: SessionProjectionEntry,
  runs: Readonly<Record<string, { status: string }>>,
  { authoritativeSequences: range }: SessionProjectionSnapshotOptions,
): boolean {
  const runId = entry.identity?.runId;
  const sequence = entry.identity?.isImported ? null : entry.identity?.sequence;
  return Boolean(
    range &&
    !entry.pending &&
    (!runId || runs[runId]?.status !== "streaming") &&
    sequence != null &&
    sequence >= range.from &&
    sequence <= range.to,
  );
}
