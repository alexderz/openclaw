// A Claude CLI run can end several native turns inside one OpenClaw run (for
// example a background task notification wakes the same process after the first
// end_turn). The local reply row then joins every result text, while the native
// transcript keeps each segment at its own position. This module proves that a
// local row is exactly such a join so display keeps only the native segments.
//
// Texts are compared in their normalized form: whitespace runs collapse to one
// space and display-stripped directive tags ([[reply_to_*]], [[audio_as_voice]])
// are removed, so a local join that differs from the segments only by line
// breaks or such tags still matches. Any other text difference keeps the row.

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasMeaningfulRetiredMediaCarrier, readPersistedMediaFacts } from "../media/media-facts.js";

type CompositeImportRow = {
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

/** Index rows as stored: `text` is the JSON-encoded normalized comparable text. */
type StoredRow = { id: number; text: string | null; timestamp: number | null };

const decode = (text: string | null) => (text === null ? null : (JSON.parse(text) as string));

const MEDIA_DIRECTIVE_LINE_RE = /^\s*MEDIA:/im;

/** Internal user rows (task notifications, harness context) do not start a turn. */
export function isInternalUserMessage(record: Record<string, unknown> | undefined): boolean {
  if (record?.role !== "user") {
    return false;
  }
  if (asOptionalRecord(record.provenance)?.kind === "internal_system") {
    return true;
  }
  // An uncoalesced tool-result carrier is part of the assistant turn, not an operator prompt.
  const content = record.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => asOptionalRecord(block)?.type === "tool_result")
  );
}

/**
 * A local row may only be hidden when its text is everything it shows. Media
 * facts, MEDIA: directives, or any non-text block would vanish with it.
 */
export function isTextOnlyMessage(record: Record<string, unknown> | undefined): boolean {
  if (!record || (readPersistedMediaFacts(record)?.length ?? 0) > 0) {
    return false;
  }
  if (hasMeaningfulRetiredMediaCarrier(record)) {
    return false;
  }
  const texts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    texts.push(text);
  }
  const content = record.content;
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const entry = asOptionalRecord(block);
      const blockText = readStringValue(entry?.text);
      if (entry?.type !== "text" || blockText === undefined) {
        return false;
      }
      texts.push(blockText);
    }
  } else if (content !== undefined && content !== null) {
    return false;
  }
  return !texts.some((value) => MEDIA_DIRECTIVE_LINE_RE.test(value));
}

function isSegment(row: CompositeImportRow, claimed: ReadonlySet<number>): boolean {
  return row.role === "assistant" && row.displayed && Boolean(row.text) && !claimed.has(row.id);
}

/**
 * Walks back from `end` and returns the imported segment ids, oldest first,
 * whose texts joined in native order equal `text`. The walk stops at any
 * non-internal user row, which belongs to an earlier turn. A single segment is
 * the ordinary text match and is never claimed here.
 */
function walkSegments(
  text: string,
  imports: readonly CompositeImportRow[],
  end: number,
  claimed: ReadonlySet<number>,
): number[] | undefined {
  let remaining = text;
  const used: number[] = [];
  for (let index = end; index >= 0 && remaining; index--) {
    const row = imports[index]!;
    if (row.role === "user" && !row.internalUser) {
      break;
    }
    if (!isSegment(row, claimed)) {
      continue;
    }
    const segment = row.text!;
    if (remaining === segment) {
      remaining = "";
    } else if (remaining.endsWith(` ${segment}`)) {
      remaining = remaining.slice(0, -(segment.length + 1));
    } else {
      // Narration between tool calls is not part of the joined result text.
      continue;
    }
    used.push(row.id);
  }
  return !remaining && used.length >= 2 ? used.toReversed() : undefined;
}

/**
 * Finds every local row that is a composite of displayed imported segments and
 * returns it with the display row of its last segment. Locals are processed in
 * order; each segment is claimed by at most one local. The last segment must lie
 * within `windowMs` of the local row; earlier segments may be older because a
 * background task can wake the run much later. Candidate last segments are found
 * by timestamp, newest native position first.
 */
export function findCompositeReplies(params: {
  locals: readonly StoredRow[];
  imports: readonly (StoredRow & { role: string | null; internal_user: number })[];
  /** Imported row id to the display row id of every displayed import. */
  displayed: ReadonlyMap<number, number>;
  windowMs: number;
}): Array<{ localId: number; target: number }> {
  const { displayed, windowMs } = params;
  const imports: CompositeImportRow[] = params.imports.map((row) => ({
    id: row.id,
    role: row.role,
    text: decode(row.text),
    timestamp: row.timestamp,
    displayed: displayed.has(row.id),
    internalUser: row.internal_user === 1,
  }));
  const timed = imports
    .flatMap((row, index) =>
      row.role === "assistant" && row.displayed && row.text && row.timestamp !== null
        ? [{ index, timestamp: row.timestamp }]
        : [],
    )
    .toSorted((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  const lowerBound = (timestamp: number) => {
    let low = 0;
    let high = timed.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (timed[middle]!.timestamp < timestamp) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const claimed = new Set<number>();
  const found: Array<{ localId: number; target: number }> = [];
  for (const row of params.locals) {
    const local = { ...row, text: decode(row.text) ?? "" };
    if (local.timestamp === null || !local.text) {
      continue;
    }
    const from = lowerBound(local.timestamp - windowMs);
    const ends: number[] = [];
    for (
      let at = from;
      at < timed.length && timed[at]!.timestamp <= local.timestamp + windowMs;
      at++
    ) {
      ends.push(timed[at]!.index);
    }
    for (const end of ends.toSorted((a, b) => b - a)) {
      const last = imports[end]!;
      if (claimed.has(last.id) || !local.text.endsWith(` ${last.text}`)) {
        continue;
      }
      const segments = walkSegments(local.text, imports, end, claimed);
      if (segments) {
        for (const id of segments) {
          claimed.add(id);
        }
        found.push({ localId: local.id, target: displayed.get(segments.at(-1)!)! });
        break;
      }
    }
  }
  return found;
}
