import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasMeaningfulRetiredMediaCarrier, readPersistedMediaFacts } from "../media/media-facts.js";

/** Only affirmatively internal user messages are not operator-turn boundaries. */
export function isInternalUserMessage(record: Record<string, unknown> | undefined): boolean {
  if (record?.role !== "user") {
    return false;
  }
  if (asOptionalRecord(record.provenance)?.kind === "internal_system") {
    return true;
  }
  return (
    Array.isArray(record.content) &&
    record.content.length > 0 &&
    record.content.every((block) => asOptionalRecord(block)?.type === "tool_result")
  );
}

/** A display row can only be retired if its entire content is plain text. */
export function isTextOnlyMessage(record: Record<string, unknown> | undefined): boolean {
  if (
    !record ||
    (readPersistedMediaFacts(record)?.length ?? 0) > 0 ||
    hasMeaningfulRetiredMediaCarrier(record)
  ) {
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
      const value = readStringValue(entry?.text);
      if (entry?.type !== "text" || value === undefined) {
        return false;
      }
      texts.push(value);
    }
  } else if (content !== undefined && content !== null) {
    return false;
  }
  return texts.some((value) => value.trim()) && !texts.some((value) => /^\s*MEDIA:/im.test(value));
}

export function canRetireCompositeReply(message: unknown, cliSessionId?: string): boolean {
  const record = asOptionalRecord(message);
  if (record?.role !== "assistant" || !isTextOnlyMessage(record)) {
    return false;
  }
  const meta = asOptionalRecord(record.__openclaw);
  const provider = readStringValue(record.provider);
  const api = readStringValue(record.api);
  const importedFrom = readStringValue(meta?.importedFrom);
  const sourceSession = readStringValue(meta?.cliSessionId);
  if (
    (provider && provider !== "claude-cli") ||
    (importedFrom && importedFrom !== "claude-cli") ||
    (sourceSession && sourceSession !== cliSessionId)
  ) {
    return false;
  }
  const idempotencyKey =
    readStringValue(record.idempotencyKey) ?? readStringValue(meta?.idempotencyKey);
  return (
    (provider === "claude-cli" &&
      (api === "cli" || Boolean(idempotencyKey?.startsWith("cli-assistant:")))) ||
    (importedFrom === "claude-cli" && Boolean(cliSessionId) && sourceSession === cliSessionId)
  );
}

export type CompositeSegment = {
  importId: number;
  displayRowId: number;
  turnStartImportId: number;
  text: string;
};
export type CompositeMatch =
  | { kind: "unique"; segments: readonly number[] }
  | { kind: "none" | "ambiguous" | "limit" };

/** Bounded suffix DP; count solutions to two, including narration-skipping alternatives. */
export function findBoundedCompositeProof(input: {
  localText: string;
  rows: readonly CompositeSegment[];
  endImportId: number;
  maxStates: number;
}): CompositeMatch {
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
  const local = normalized(input.localText);
  const end = input.rows.findIndex((row) => row.importId === input.endImportId);
  if (end < 0 || !local || end !== input.rows.length - 1) {
    return { kind: "none" };
  }
  const last = normalized(input.rows[end]!.text);
  if (!last || !local.endsWith(` ${last}`)) {
    return { kind: "none" };
  }
  type State = { remaining: string; ids: number[] };
  let states: State[] = [{ remaining: local.slice(0, -last.length - 1), ids: [input.endImportId] }];
  let work = 1;
  let solution: number[] | undefined;
  for (let index = end - 1; index >= 0; index--) {
    const row = input.rows[index]!;
    const text = normalized(row.text);
    const next: State[] = [];
    for (const state of states) {
      if (++work > input.maxStates) {
        return { kind: "limit" };
      }
      next.push(state);
      if (!text) {
        continue;
      }
      if (state.ids.length >= 32) {
        if (state.remaining === text || state.remaining.endsWith(` ${text}`)) {
          return { kind: "limit" };
        }
        continue;
      }
      if (state.remaining === text) {
        const candidate = [row.importId, ...state.ids];
        if (solution) {
          return { kind: "ambiguous" };
        }
        solution = candidate;
      } else if (state.remaining.endsWith(` ${text}`)) {
        next.push({
          remaining: state.remaining.slice(0, -text.length - 1),
          ids: [row.importId, ...state.ids],
        });
      }
    }
    states = next;
  }
  return solution ? { kind: "unique", segments: solution } : { kind: "none" };
}
