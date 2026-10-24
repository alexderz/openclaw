import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { fnv1aUtf16 } from "../../lib/fnv1a.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";

/**
 * On-screen order of one chat view. A row the reader has seen keeps its place
 * until an explicit Reload; later rows only ever land after it (DER-615).
 */
export type ChatDisplayOrderState = {
  /** Every key shown since the view began, in display order. Absent keys keep their slot. */
  ledger: string[];
  /** Keys of the previous display with the facts that let a replacement take their slot. */
  shown: Map<string, readonly string[]>;
};

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

/**
 * Order `items` (the freshly projected transcript) against what is already on
 * screen. Rows already shown keep their relative order even when the source
 * re-sorts them. A new row may only take the slot of a row this projection
 * removed (a placeholder swapped for its stored copy), sit above every shown
 * row (older history paged in), or land after the last shown row. Rows in
 * `floating` are the live edge (the reply being generated, the working
 * indicator, inputs queued behind the run): they follow every placed row and
 * do not enter the ledger.
 */
export function holdChatDisplayOrder(
  items: readonly ChatItem[],
  state: ChatDisplayOrderState,
  floating: ReadonlySet<string> = new Set(),
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
    state.shown = new Map(placed.map((item) => [item.key, replacementSignatures(item)]));
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
      for (const signature of state.shown.get(key) ?? []) {
        const bucket = removedBySignature.get(signature) ?? [];
        bucket.push(key);
        removedBySignature.set(signature, bucket);
      }
    }
    for (const item of placed) {
      if (ledgerIndex.has(item.key)) {
        continue;
      }
      for (const signature of replacementSignatures(item)) {
        const slot = removedBySignature.get(signature)?.find((key) => !slotOwners.has(key));
        if (slot) {
          claim(slot, item.key);
          break;
        }
      }
    }
  }
  const positionOf = (key: string) => ledgerIndex.get(slotOf.get(key) ?? key);
  const prependBefore = new Map<string, string[]>();
  const appended: string[] = [];
  let anchor = -1;
  for (const [index, key] of keys.entries()) {
    const known = positionOf(key);
    if (known !== undefined) {
      anchor = Math.max(anchor, known);
      continue;
    }
    // A removed row between the reader's neighbors is the slot a reconciled
    // copy fills; a shown row in between closes the gap.
    for (let cursor = anchor + 1; cursor < state.ledger.length; cursor++) {
      const candidate = state.ledger[cursor]!;
      if (present.has(candidate) || slotOwners.has(candidate)) {
        break;
      }
      if (removed.has(candidate)) {
        claim(candidate, key);
        anchor = cursor;
        break;
      }
    }
    if (slotOf.has(key)) {
      continue;
    }
    const successor =
      anchor < 0 ? keys.slice(index + 1).find((next) => positionOf(next) !== undefined) : undefined;
    if (successor) {
      const before = slotOf.get(successor) ?? successor;
      const bucket = prependBefore.get(before) ?? [];
      bucket.push(key);
      prependBefore.set(before, bucket);
    } else {
      appended.push(key);
    }
  }
  const ledger: string[] = [];
  for (const key of state.ledger) {
    ledger.push(...(prependBefore.get(key) ?? []));
    const owner = slotOwners.get(key);
    ledger.push(owner ?? key);
  }
  ledger.push(...appended);
  remember(ledger);
  const order = new Map(ledger.map((key, index) => [key, index]));
  const ordered = placed.toSorted((left, right) => order.get(left.key)! - order.get(right.key)!);
  return [...ordered, ...floats];
}
