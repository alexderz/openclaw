import { getAgentRunContext } from "../infra/agent-run-registry.js";

/** Adds the run's admitted turn class to a chat event; the run context is the only source. */
export function stampChatEventAuthorityClass<T>(payload: T): T {
  const runId = (payload as { runId?: unknown } | null)?.runId;
  const authorityClass =
    typeof runId === "string" ? getAgentRunContext(runId)?.authorityClass : undefined;
  return authorityClass ? { ...payload, authorityClass } : payload;
}
