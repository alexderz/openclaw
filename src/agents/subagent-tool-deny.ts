import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

/**
 * Tools always denied for sub-agents regardless of depth.
 * These are system-level or interactive tools that sub-agents should never use.
 * Dependency-free so clients can name this standard set without the policy runtime.
 */
export const SUBAGENT_TOOL_DENY_ALWAYS: readonly string[] = [
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  "openclaw",
  // Status/scheduling - main agent coordinates
  "session_status",
  "progress_card",
  AUTOMATIONS_TOOL_NAME,
  // Direct user/session sends - subagents communicate through announce chain
  "message",
  "sessions_send",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
];

/** Tools that only make sense for orchestrator sub-agents that can spawn children. */
export const SUBAGENT_TOOL_DENY_LEAF: readonly string[] = [
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_spawn",
];
