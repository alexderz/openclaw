import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";

/** Class a typed user turn was admitted under; display only, it never grants or limits. */
export type TurnAuthorityClass = "ordinary" | "delegated";

const RUN_USER_TURN_SUFFIX = ":user";
const RUN_AUTHORITY_LIMIT = 256;

/**
 * Classes live chat events reported per run, for the local copy of a turn that the transcript
 * has not echoed back yet. Run ids are unique, so one bounded table serves every pane.
 */
const runAuthority = new Map<string, TurnAuthorityClass>();

function readAuthorityClass(value: unknown): TurnAuthorityClass | undefined {
  return value === "ordinary" || value === "delegated" ? value : undefined;
}

/** Records the class a live chat event reported for its run; unknown values are ignored. */
export function recordRunAuthorityClass(runId: string | undefined, value: unknown): void {
  const authorityClass = readAuthorityClass(value);
  if (!runId || !authorityClass || runAuthority.get(runId) === authorityClass) {
    return;
  }
  runAuthority.delete(runId);
  runAuthority.set(runId, authorityClass);
  if (runAuthority.size > RUN_AUTHORITY_LIMIT) {
    const oldest = runAuthority.keys().next().value;
    if (oldest !== undefined) {
      runAuthority.delete(oldest);
    }
  }
}

/**
 * The stamped class of a user turn: the transcript's `__openclaw.authorityClass`, else what a
 * live chat event reported for the run the local copy belongs to. Unstamped turns, including
 * every turn older than the stamp, read undefined; nothing is inferred from the session.
 */
export function readTurnAuthorityClass(message: unknown): TurnAuthorityClass | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user") {
    return undefined;
  }
  const meta = asOptionalRecord(record["__openclaw"]);
  const stamped = readAuthorityClass(meta?.authorityClass);
  if (stamped) {
    return stamped;
  }
  const idempotencyKey = readStringField(meta, "idempotencyKey");
  if (!idempotencyKey?.endsWith(RUN_USER_TURN_SUFFIX)) {
    return undefined;
  }
  return runAuthority.get(idempotencyKey.slice(0, -RUN_USER_TURN_SUFFIX.length));
}

/** Test seam: forget every recorded run. */
export function resetRunAuthorityTestState(): void {
  runAuthority.clear();
}
