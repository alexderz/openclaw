// A Claude CLI run can end several native turns inside one OpenClaw run (for
// example a background task notification wakes the same process after the first
// end_turn). The local reply row then joins every result text, while the native
// transcript keeps each segment at its own position. This module proves that a
// local row is exactly such a join so display keeps only the native segments.

export type CompositeImportRow = {
  /** Imported row id, in native transcript order. */
  id: number;
  role: string | null;
  /** Normalized comparable text, already decoded. */
  text: string | null;
  timestamp: number | null;
  /** True when the import was not matched to a local row and is displayed. */
  displayed: boolean;
  /** Internal user rows (task notifications, harness context) do not start a turn. */
  internalUser: boolean;
};

/**
 * Returns the imported segment ids, oldest first, whose texts joined in native
 * order equal `local.text`, or undefined. The last segment must lie within
 * `windowMs` of the local row; earlier segments may be older because a
 * background task can wake the run much later. The walk stops at an operator
 * user row, which belongs to an earlier turn. A single segment is the ordinary
 * text match and is never claimed here.
 */
export function matchCompositeReplySegments(params: {
  local: { text: string; timestamp: number | null };
  imports: readonly CompositeImportRow[];
  claimed: ReadonlySet<number>;
  windowMs: number;
}): number[] | undefined {
  const { local, imports, claimed, windowMs } = params;
  const isSegment = (row: CompositeImportRow) =>
    row.role === "assistant" && row.displayed && Boolean(row.text) && !claimed.has(row.id);
  for (let end = imports.length - 1; end >= 0; end--) {
    const last = imports[end]!;
    if (
      !isSegment(last) ||
      local.timestamp === null ||
      last.timestamp === null ||
      Math.abs(last.timestamp - local.timestamp) > windowMs ||
      !local.text.endsWith(` ${last.text}`)
    ) {
      continue;
    }
    let remaining = local.text;
    const used: number[] = [];
    for (let index = end; index >= 0 && remaining; index--) {
      const row = imports[index]!;
      if (row.role === "user" && row.text && !row.internalUser) {
        break;
      }
      if (!isSegment(row)) {
        continue;
      }
      const text = row.text!;
      if (remaining === text) {
        remaining = "";
      } else if (remaining.endsWith(` ${text}`)) {
        remaining = remaining.slice(0, -(text.length + 1));
      } else {
        // Narration between tool calls is not part of the joined result text.
        continue;
      }
      used.push(row.id);
    }
    if (!remaining && used.length >= 2) {
      return used.toReversed();
    }
  }
  return undefined;
}
