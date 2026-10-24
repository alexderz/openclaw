// Owns the paced cron next-check proposal carried on a live run context.
import { getAgentRunContext, hasAgentRunContextExecutionOwner } from "./agent-run-registry.js";

/** Records the latest next-check proposal on the matching live cron run. */
export function recordCronNextCheckProposal(runId: string, jobId: string, delayMs: number): void {
  const context = getAgentRunContext(runId);
  const cronRun = context?.cronRunsByJobId?.get(jobId);
  if (!cronRun || !hasAgentRunContextExecutionOwner(runId)) {
    throw new Error("cron next_check is only available to the currently running job");
  }
  if (!cronRun.nextCheckEnabled) {
    throw new Error("cron next_check requires pacing or a one-shot session continuation");
  }
  cronRun.nextCheckMs = delayMs;
}

/** Consumes one successful cron run's proposal so it cannot affect a later run. */
export function consumeCronNextCheckProposal(runId: string, jobId: string): number | undefined {
  const context = getAgentRunContext(runId);
  const cronRuns = context?.cronRunsByJobId;
  const cronRun = cronRuns?.get(jobId);
  if (!cronRun) {
    return undefined;
  }
  cronRuns?.delete(jobId);
  if (cronRuns?.size === 0 && context) {
    delete context.cronRunsByJobId;
  }
  return cronRun.nextCheckMs;
}
