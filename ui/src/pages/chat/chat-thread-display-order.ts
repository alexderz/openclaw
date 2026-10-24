import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { fnv1aUtf16 } from "../../lib/fnv1a.ts";

/**
 * On-screen order of one chat view. A row the reader has seen keeps its place
 * until an explicit Reload; later rows only ever land after it (DER-615).
 */
export type ChatDisplayOrderState = {
  /** Every key shown since the view began, in display order. Absent keys keep their slot. */
  ledger: string[];
  /** Keys of the previous display with the facts that let a replacement take their slot. */
  shown: Map<string, ShownRow>;
  /** Ledger keys shown as a stored row (one with a transcript sequence), not a local copy. */
  stored: Set<string>;
};

type ShownRow = { signatures: readonly string[]; runId: string | null; gapKey: string | null };

export function createChatDisplayOrderState(): ChatDisplayOrderState {
  return { ledger: [], shown: new Map(), stored: new Set() };
}

export function resetChatDisplayOrder(state: ChatDisplayOrderState): void {
  state.ledger = [];
  state.shown = new Map();
  state.stored = new Set();
}

// A long-lived view sheds absent slots once they outnumber the shown rows.
const LEDGER_SLACK = 500;

const textSignature = (role: string, text: string) =>
  `text:${role}:${fnv1aUtf16(text).toString(36)}:${text.length.toString(36)}`;

// Message objects outlive rebuilds; their facts are hashed once.
const messageSignatures = new WeakMap<object, readonly string[]>();

function messageReplacementSignatures(message: unknown): readonly string[] {
  if (message && typeof message === "object") {
    const cached = messageSignatures.get(message);
    if (cached) {
      return cached;
    }
  }
  const record = asRecord(message);
  const signatures: string[] = [];
  const callId = typeof record?.toolCallId === "string" ? record.toolCallId.trim() : "";
  if (callId) {
    signatures.push(`call:${callId}`);
  }
  const role = typeof record?.role === "string" ? normalizeRoleForGrouping(record.role) : "";
  const text = record ? extractTextCached(message)?.trim() : undefined;
  if (text) {
    signatures.push(textSignature(role, text));
  }
  if (message && typeof message === "object") {
    messageSignatures.set(message, signatures);
  }
  return signatures;
}

/**
 * Facts shared by a provisional row and the stored row that replaces it: a
 * live tool card and its saved result share the call, and a pending bubble or
 * stream segment shares its text with the saved message.
 */
function replacementSignatures(item: ChatItem): readonly string[] {
  switch (item.kind) {
    case "message":
      return messageReplacementSignatures(item.message);
    case "stream": {
      const text = item.text.trim();
      return text ? [textSignature("assistant", text)] : [];
    }
    case "notice": {
      const text = item.text.trim();
      return text ? [`notice:${fnv1aUtf16(text).toString(36)}:${text.length.toString(36)}`] : [];
    }
    case "divider":
      return item.compactionId ? [`compaction:${item.compactionId}`] : [];
    default:
      return [];
  }
}

function rowRunId(item: ChatItem): string | null {
  if (item.kind === "message") {
    return readSessionMessageIdentity(item.message)?.runId ?? null;
  }
  return "runId" in item && typeof item.runId === "string" ? item.runId : null;
}

/**
 * What lets a new row take a removed row's place between the same neighbors:
 * the same run, or, for rows without any stored identity (keyed by content),
 * the same role.
 */
function rowGapKey(item: ChatItem): string | null {
  const runId = rowRunId(item);
  if (runId || item.kind !== "message") {
    return runId ? `run:${runId}` : null;
  }
  const identity = readSessionMessageIdentity(item.message);
  const record = asRecord(item.message);
  return identity?.id || identity?.sendId || identity?.sequence != null
    ? null
    : `anonymous:${typeof record?.role === "string" ? normalizeRoleForGrouping(record.role) : ""}`;
}

function rowSequence(item: ChatItem): number | null {
  return item.kind === "message"
    ? (readSessionMessageIdentity(item.message)?.sequence ?? null)
    : null;
}

type TranscriptPlace = { sequence: number; index: number };

/** Transcript order: sequence, then source position for rows that share one. */
const precedes = (left: TranscriptPlace, right: TranscriptPlace) =>
  left.sequence < right.sequence || (left.sequence === right.sequence && left.index < right.index);

/** Indexes of the longest run of `places` that ascends in transcript order. */
function longestAscending(places: readonly TranscriptPlace[]): number[] {
  const tails: number[] = [];
  const previous: number[] = [];
  for (const [index, place] of places.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (precedes(places[tails[middle]!]!, place)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const result: number[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) {
    result.push(index);
  }
  return result.toReversed();
}

/**
 * Order `items` (the freshly projected transcript) against what is already on
 * screen. Rows already shown keep their relative order even when the source
 * re-sorts them. A new row lands after the last shown row, even with an older
 * timestamp, unless it is the stored copy of a row this projection removed
 * (same tool call or text, or the same run in that row's gap), or it is a
 * stored row recorded before a shown stored row (an older page, or a gap in
 * the loaded window): that row takes its place among the shown stored rows by
 * transcript sequence, so a question stays above its answer (DER-623). A local
 * copy shown before its stored row (a send's bubble) yields its slot when the
 * stored row turns out to precede a stored row shown above it. A stopped
 * pending input (`settledInputKeys`) is already placed by its accepted time.
 * When that place is before a row on screen, it keeps it instead of landing
 * at the bottom with the other sequenceless late arrivals. One that follows
 * every shown row still lands at the bottom. Rows in `floating` are the live
 * edge (the reply being generated, its working indicator, inputs queued
 * behind the run): they follow every placed row and do not enter the ledger.
 */
export function holdChatDisplayOrder(
  items: readonly ChatItem[],
  state: ChatDisplayOrderState,
  {
    floating = new Set(),
    historyKeys,
    settledInputKeys,
  }: {
    floating?: ReadonlySet<string>;
    historyKeys?: ReadonlySet<string>;
    settledInputKeys?: ReadonlySet<string>;
  } = {},
): ChatItem[] {
  const placed = items.filter((item) => !floating.has(item.key));
  const floats = items.filter((item) => floating.has(item.key));
  const keys = placed.map((item) => item.key);
  const present = new Set(keys);
  const remember = (ledger: string[]) => {
    state.ledger =
      ledger.length > present.size * 2 + LEDGER_SLACK
        ? ledger.filter((key) => present.has(key))
        : ledger;
    if (state.ledger !== ledger) {
      state.stored = new Set([...state.stored].filter((key) => present.has(key)));
    }
    for (const item of placed) {
      if (rowSequence(item) !== null) {
        state.stored.add(item.key);
      }
    }
    state.shown = new Map(
      placed.map((item) => [
        item.key,
        {
          signatures: replacementSignatures(item),
          runId: rowRunId(item),
          gapKey: rowGapKey(item),
        },
      ]),
    );
  };
  if (present.size !== keys.length) {
    // Duplicate row keys have no single position to hold; start over.
    state.stored = new Set();
    remember(keys);
    return items.slice();
  }
  if (state.ledger.length === 0) {
    remember(keys);
    return [...placed, ...floats];
  }
  const ledgerIndex = new Map(state.ledger.map((key, index) => [key, index]));
  const removed = new Set(
    [...state.shown.keys()].filter((key) => !present.has(key) && ledgerIndex.has(key)),
  );
  // Slot key -> the new key that takes it.
  const slotOwners = new Map<string, string>();
  const slotOf = new Map<string, string>();
  const claim = (slot: string, key: string) => {
    slotOwners.set(slot, key);
    slotOf.set(key, slot);
  };
  if (removed.size > 0) {
    const removedBySignature = new Map<string, string[]>();
    for (const key of removed) {
      for (const signature of state.shown.get(key)?.signatures ?? []) {
        const bucket = removedBySignature.get(signature) ?? [];
        bucket.push(key);
        removedBySignature.set(signature, bucket);
      }
    }
    for (const item of placed) {
      if (ledgerIndex.has(item.key)) {
        continue;
      }
      // Equal text from another run is another message ("Done" twice).
      const runId = rowRunId(item);
      const compatible = (key: string) => {
        const shownRunId = state.shown.get(key)?.runId;
        return !runId || !shownRunId || shownRunId === runId;
      };
      for (const signature of replacementSignatures(item)) {
        const slot = removedBySignature
          .get(signature)
          ?.find((key) => !slotOwners.has(key) && compatible(key));
        if (slot) {
          claim(slot, item.key);
          break;
        }
      }
    }
  }
  const ledgerKeyOf = (key: string) => slotOf.get(key) ?? key;
  // Stored rows on screen whose places ascend with their sequences anchor the
  // stored rows that were never shown; a row shown out of that order does not.
  const shownStored = placed.flatMap((item, index) => {
    const ledgerKey = ledgerKeyOf(item.key);
    const position = ledgerIndex.get(ledgerKey);
    const sequence = rowSequence(item);
    return position !== undefined && sequence !== null && state.stored.has(ledgerKey)
      ? [{ ledgerKey, position, sequence, index }]
      : [];
  });
  shownStored.sort((left, right) => left.position - right.position);
  const storedAnchors = longestAscending(shownStored).map((index) => shownStored[index]!);
  // A local copy shown before its stored row (a send's bubble) held a slot
  // without a sequence. When its stored row contradicts that slot (a stored
  // row recorded after it sits above, or one recorded before it below), the
  // slot is placed again by sequence, so the question sits above its answer.
  // A copy whose slot agrees keeps it and anchors its neighbors like a stored row.
  const misplaced = new Set<string>();
  const agreeing: typeof shownStored = [];
  for (const [index, item] of placed.entries()) {
    const ledgerKey = ledgerKeyOf(item.key);
    const position = ledgerIndex.get(ledgerKey);
    const sequence = rowSequence(item);
    if (position === undefined || sequence === null || state.stored.has(ledgerKey)) {
      continue;
    }
    const place = { sequence, index };
    const contradicted = storedAnchors.some((stored) =>
      stored.position < position ? precedes(place, stored) : precedes(stored, place),
    );
    if (contradicted) {
      misplaced.add(item.key);
    } else {
      agreeing.push({ ledgerKey, position, sequence, index });
    }
  }
  const candidates = [...storedAnchors, ...agreeing].toSorted(
    (left, right) => left.position - right.position,
  );
  const anchors = longestAscending(candidates).map((index) => candidates[index]!);
  const newestAnchor = anchors.at(-1);
  // The vacated slot leaves the ledger; a claimed slot stays an absent key.
  const vacated = new Set<string>();
  for (const key of misplaced) {
    const slot = slotOf.get(key);
    if (slot) {
      slotOwners.delete(slot);
      slotOf.delete(key);
    } else {
      vacated.add(key);
    }
  }
  const positionOf = (key: string) =>
    misplaced.has(key) ? undefined : ledgerIndex.get(ledgerKeyOf(key));
  // Rows recorded before every anchor go above it and above the shown rows
  // without a sequence that lead into it (a notice, a divider).
  let headKey = anchors[0]?.ledgerKey;
  let headPosition = anchors[0]?.position ?? -1;
  for (const [index, item] of placed.entries()) {
    const position = positionOf(item.key);
    if (index < (anchors[0]?.index ?? -1) && position !== undefined && position < headPosition) {
      headKey = ledgerKeyOf(item.key);
      headPosition = position;
    }
  }
  // Without stored anchors, an older page is loaded history above every
  // retained row. A row recorded after a retained row (a later sequence) is a
  // late arrival, whatever its timestamp, and so are live projections.
  let oldestShownSequence = Number.POSITIVE_INFINITY;
  for (const item of placed) {
    const sequence = positionOf(item.key) !== undefined ? rowSequence(item) : null;
    if (sequence !== null && sequence < oldestShownSequence) {
      oldestShownSequence = sequence;
    }
  }
  const firstRetained = keys.findIndex((key) => positionOf(key) !== undefined);
  const isHistory = (item: ChatItem) => historyKeys?.has(item.key) ?? true;
  const olderRows = placed.slice(0, Math.max(0, firstRetained)).filter(isHistory);
  const olderPage =
    anchors.length === 0 &&
    olderRows.length > 0 &&
    olderRows.every(
      (item) => (rowSequence(item) ?? Number.NEGATIVE_INFINITY) < oldestShownSequence,
    );
  const prepended: string[] = [];
  const appended: string[] = [];
  // Ledger key -> rows recorded just before / after it (stored rows and the
  // history rows without a sequence that follow them), in source order.
  const insertedBefore = new Map<string, string[]>();
  const insertedAfter = new Map<string, string[]>();
  const insertionList = (lists: Map<string, string[]>, ledgerKey: string) => {
    let list = lists.get(ledgerKey);
    if (!list) {
      list = [];
      lists.set(ledgerKey, list);
    }
    return list;
  };
  // The stored rows recorded before `place` end at the returned anchor.
  const anchorBefore = (place: TranscriptPlace) => {
    let low = 0;
    let high = anchors.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (precedes(anchors[middle]!, place)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low > 0 ? anchors[low - 1]! : null;
  };
  // A page loaded above the anchors brings stored rows recorded before them all.
  const firstAnchor = anchors[0];
  const olderLoaded =
    firstAnchor !== undefined &&
    placed.some((item, index) => {
      const sequence = rowSequence(item);
      return (
        positionOf(item.key) === undefined &&
        !misplaced.has(item.key) &&
        sequence !== null &&
        precedes({ sequence, index }, firstAnchor)
      );
    });
  let anchor = -1;
  // History rows without a sequence (a divider, a canvas card) follow a row
  // this pass placed by sequence just before them.
  let group: string[] | null = null;
  // True when a row already on screen comes later in this projection. A
  // stopped input placed before that row is not a late arrival.
  const hasShownAfter: boolean[] = Array.from({ length: placed.length }, () => false);
  for (let index = placed.length - 1, seen = false; index >= 0; index -= 1) {
    hasShownAfter[index] = seen;
    if (positionOf(placed[index]!.key) !== undefined) {
      seen = true;
    }
  }
  let previousShownLedgerKey: string | undefined;
  for (const [index, item] of placed.entries()) {
    const key = item.key;
    const known = positionOf(key);
    if (known !== undefined) {
      anchor = Math.max(anchor, known);
      previousShownLedgerKey = ledgerKeyOf(key);
      group = null;
      continue;
    }
    if (settledInputKeys?.has(key) && hasShownAfter[index]) {
      const listKey =
        previousShownLedgerKey ??
        headKey ??
        (firstRetained >= 0 ? ledgerKeyOf(keys[firstRetained]!) : undefined);
      if (listKey) {
        insertionList(previousShownLedgerKey ? insertedAfter : insertedBefore, listKey).push(key);
        group = null;
        continue;
      }
    }
    if (olderPage && index < firstRetained && isHistory(item)) {
      prepended.push(key);
      continue;
    }
    const sequence = rowSequence(item);
    const place = sequence === null ? null : { sequence, index };
    if (place && newestAnchor && precedes(place, newestAnchor)) {
      // Recorded before a stored row on screen: not a late arrival. It joins
      // the stored rows by sequence without moving any of them.
      const before = anchorBefore(place);
      group = before
        ? insertionList(insertedAfter, before.ledgerKey)
        : insertionList(insertedBefore, headKey!);
      group.push(key);
      continue;
    }
    // A removed row of the same run between the reader's neighbors is the slot
    // its reconciled copy fills; a shown row in between closes the gap. A copy
    // placed again by sequence does not take back the slot it left.
    const gapKey = misplaced.has(key) ? null : rowGapKey(item);
    for (let cursor = anchor + 1; cursor < state.ledger.length; cursor++) {
      const candidate = state.ledger[cursor]!;
      if (!gapKey || present.has(candidate) || slotOwners.has(candidate)) {
        break;
      }
      if (removed.has(candidate) && state.shown.get(candidate)?.gapKey === gapKey) {
        claim(candidate, key);
        anchor = cursor;
        break;
      }
    }
    if (slotOf.has(key)) {
      group = null;
      continue;
    }
    if (sequence === null && isHistory(item) && anchors.length > 0) {
      if (group) {
        group.push(key);
        continue;
      }
      if (anchor < 0 && olderLoaded) {
        // Loaded above every shown row (Show earlier).
        group = insertionList(insertedBefore, headKey!);
        group.push(key);
        continue;
      }
    }
    group = null;
    appended.push(key);
  }
  const before = olderPage ? ledgerKeyOf(keys[firstRetained]!) : null;
  const ledger: string[] = [];
  for (const key of state.ledger) {
    if (key === before) {
      ledger.push(...prepended);
    }
    ledger.push(...(insertedBefore.get(key) ?? []));
    if (!vacated.has(key)) {
      ledger.push(slotOwners.get(key) ?? key);
    }
    ledger.push(...(insertedAfter.get(key) ?? []));
  }
  ledger.push(...appended);
  remember(ledger);
  const order = new Map(ledger.map((key, index) => [key, index]));
  const ordered = placed.toSorted((left, right) => order.get(left.key)! - order.get(right.key)!);
  return [...ordered, ...floats];
}
