import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";

export type SessionEntryObligationBlocker = { code: string; owner: "session-row"; field?: string };

/**
 * Durable obligations that live on the session row itself and survive a Gateway restart before
 * any in-memory owner has been rebuilt. Their owners compare `sessionId`/`lifecycleRevision`, so
 * rotating the revision under them would drop or suppress the effect. Anything present is a
 * blocker; only a recognized, finished terminal state (`delivered-terminal`) is not. Unreadable
 * input is a blocker too. Pure and synchronous: callable outside the fence as an advisory
 * pre-check and again inside it, on the row the commit will rewrite, as the authoritative one.
 */
export function probeSessionEntryObligations(
  entry: InternalSessionEntry | undefined,
): SessionEntryObligationBlocker[] {
  const blockers: SessionEntryObligationBlocker[] = [];
  if (!entry) {
    return [{ code: "session-row-unavailable", owner: "session-row" }];
  }
  const add = (code: string, field?: string) =>
    blockers.push({ code, owner: "session-row", ...(field ? { field } : {}) });
  try {
    if (entry.pendingFinalDelivery !== undefined) {
      add("pending-final-delivery", "pendingFinalDelivery");
    }
    if (entry.pendingDeliveryNotice && entry.pendingDeliveryNotice.state !== "acknowledged") {
      add("pending-delivery-notice", "pendingDeliveryNotice");
    }
    if (entry.pendingTranscriptRepair?.length) {
      add("pending-transcript-repair", "pendingTranscriptRepair");
    }
    // A user Stop also records abortedLastRun with a terminal status; only an interrupted run
    // with no persisted terminal status is awaiting restart recovery (10.5 never persists
    // "running"; its recovery claim fields are blocked separately below).
    if (entry.abortedLastRun === true && entry.status === undefined) {
      add("interrupted-run-awaiting-recovery", "abortedLastRun");
    }
    if (entry.lifecycleRunId !== undefined) {
      add("lifecycle-run-open", "lifecycleRunId");
    }
    if (entry.mainRestartRecovery !== undefined) {
      add("restart-recovery", "mainRestartRecovery");
    }
    for (const [field, value] of Object.entries(entry)) {
      if (!field.startsWith("restartRecovery") || value === undefined) {
        continue;
      }
      if (field === "restartRecoveryDeliveryReceiptState" && value === "delivered-terminal") {
        continue;
      }
      add("restart-recovery", field);
    }
    // A persisted writer id is a stale marker once its run is gone; only a live run owns the
    // transcript writer.
    if (entry.activeWriterRunId && hasLiveAgentRunContext(entry.activeWriterRunId)) {
      add("transcript-writer-live", "activeWriterRunId");
    }
  } catch {
    add("session-row-unreadable");
  }
  return blockers;
}
