import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Publication envelopes run another store's command on the borrowed connection.
// Their own type names only the envelope, so diagnostics append the inner command.
const ENVELOPE_COMMAND_TYPES = new Set(["database.domain.execute", "database.domain.publish"]);

/** Diagnostic operation name for a worker command; never includes command input values. */
export function describeSqliteWorkerOperation(command: { type: string; input?: unknown }): string {
  if (!ENVELOPE_COMMAND_TYPES.has(command.type) || !isRecord(command.input)) {
    return command.type;
  }
  const inner = command.input.command;
  if (!isRecord(inner) || typeof inner.type !== "string" || !inner.type) {
    return command.type;
  }
  return `${command.type}:${inner.type}`;
}
