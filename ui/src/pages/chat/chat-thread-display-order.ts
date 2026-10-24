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
};

type ShownRow = { signatures: readonly string[]; runId: string | null; gapKey: string | null };

export function createChatDisplayOrderState(): ChatDisplayOrderState {
  return { ledger: [], shown: new Map() };
}

export function resetChatDisplayOrder(state: ChatDisplayOrderState): void {
  state.ledger = [];
  state.shown = new Map();
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

/**
 * Order `items` (the freshly projected transcript) against what is already on
 * screen. Rows already shown keep their relative order even when the source
 * re-sorts them. A new row lands after the last shown row, even with an older
 * timestamp, unless it is the stored copy of a row this projection removed
 * (same tool call or text, or the same run in that row's gap), or it belongs to
 * an older page (Show earlier): loaded history above every shown row, none of
 * it recorded after them. Rows in `floating` are the live edge (the reply being
 * generated, its working indicator, inputs queued behind the run): they follow
 * every placed row and do not enter the ledger.
 */
export function holdChatDisplayOrder(
  items: readonly ChatItem[],
  state: ChatDisplayOrderState,
  {
    floating = new Set(),
    historyKeys,
  }: { floating?: ReadonlySet<string>; historyKeys?: ReadonlySet<string> } = {},
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
  const positionOf = (key: string) => ledgerIndex.get(slotOf.get(key) ?? key);
  // An older page is loaded history above every retained row. A row recorded
  // after a retained row (a later sequence) is a late arrival, whatever its
  // timestamp, and so are live projections.
  let oldestShownSequence = Number.POSITIVE_INFINITY;
  for (const item of placed) {
    const sequence = ledgerIndex.has(item.key) ? rowSequence(item) : null;
    if (sequence !== null && sequence < oldestShownSequence) {
      oldestShownSequence = sequence;
    }
  }
  const firstRetained = keys.findIndex((key) => positionOf(key) !== undefined);
  const isHistory = (item: ChatItem) => historyKeys?.has(item.key) ?? true;
  const olderRows = placed.slice(0, Math.max(0, firstRetained)).filter(isHistory);
  const olderPage =
    olderRows.length > 0 &&
    olderRows.every(
      (item) => (rowSequence(item) ?? Number.NEGATIVE_INFINITY) < oldestShownSequence,
    );
  const prepended: string[] = [];
  const appended: string[] = [];
  let anchor = -1;
  for (const [index, item] of placed.entries()) {
    const key = item.key;
    const known = positionOf(key);
    if (known !== undefined) {
      anchor = Math.max(anchor, known);
      continue;
    }
    if (olderPage && index < firstRetained && isHistory(item)) {
      prepended.push(key);
      continue;
    }
    // A removed row of the same run between the reader's neighbors is the slot
    // its reconciled copy fills; a shown row in between closes the gap.
    const gapKey = rowGapKey(item);
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
    if (!slotOf.has(key)) {
      appended.push(key);
    }
  }
  const before = olderPage ? (slotOf.get(keys[firstRetained]!) ?? keys[firstRetained]!) : null;
  const ledger: string[] = [];
  for (const key of state.ledger) {
    if (key === before) {
      ledger.push(...prepended);
    }
    ledger.push(slotOwners.get(key) ?? key);
  }
  ledger.push(...appended);
  remember(ledger);
  const order = new Map(ledger.map((key, index) => [key, index]));
  const ordered = placed.toSorted((left, right) => order.get(left.key)! - order.get(right.key)!);
  return [...ordered, ...floats];
}
