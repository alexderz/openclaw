import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function readReplayedTaskId(
  message: Record<string, unknown>,
  inputUuid: string,
): string | undefined {
  if (
    message.type !== "user" ||
    message.isReplay !== true ||
    message.parent_tool_use_id !== null ||
    message.uuid === inputUuid ||
    !isRecord(message.message)
  ) {
    return undefined;
  }
  // Before Claude Code 2.1.274, inline notification receipts omitted origin.
  if (
    message.origin !== undefined &&
    (!isRecord(message.origin) ||
      message.origin.kind !== "task-notification" ||
      message.origin.subkind !== undefined)
  ) {
    return undefined;
  }
  const content = message.message.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof content === "string"
      ? content
      : isRecord(first) && first.type === "text" && typeof first.text === "string"
        ? first.text
        : "";
  return /^<task-notification>\s*<task-id>([^<]+)<\/task-id>/u.exec(text)?.[1];
}

export type NativeTaskOccurrence = {
  taskId: string;
  runId?: string;
  ownerInputUuid: string | false;
  phase: "running" | "notified" | "acknowledged";
};

export function recordTaskOwnership(
  session: {
    taskOwners: Map<string, string | false>;
    taskRuns: Map<string, NativeTaskOccurrence>;
    currentTaskOccurrence: Map<string, NativeTaskOccurrence>;
  },
  task: Record<string, unknown>,
  inputUuid: string,
  start: boolean,
  restart: boolean,
): NativeTaskOccurrence | undefined {
  const taskId = task.task_id;
  if (typeof taskId !== "string" || !taskId) return undefined;
  const runId = typeof task.run_id === "string" && task.run_id ? task.run_id : undefined;
  const known = runId ? session.taskRuns.get(runId) : session.currentTaskOccurrence.get(taskId);
  if (known && (known.taskId !== taskId || (runId && known.runId !== runId))) return undefined;
  if (known && (!start || !restart || known.phase === "running" || runId)) return known;
  if (!start) return undefined;
  const previous = session.taskOwners.get(taskId);
  const owner = task.owned_by_subagent === true || typeof task.parent_task_id === "string"
    ? false : (previous ?? (inputUuid || false));
  if (previous !== undefined && previous !== owner) return undefined;
  session.taskOwners.set(taskId, owner);
  const occurrence: NativeTaskOccurrence = { taskId, runId, ownerInputUuid: owner, phase: "running" };
  if (runId) session.taskRuns.set(runId, occurrence);
  session.currentTaskOccurrence.set(taskId, occurrence);
  return occurrence;
}

/** Agents and workflows make their own tool calls; subagent-owned work can resume its Agent. */
export function isDescendantTask(task: Record<string, unknown>): boolean {
  return (
    task.task_type === "local_agent" ||
    task.task_type === "local_workflow" ||
    task.owned_by_subagent === true ||
    typeof task.parent_task_id === "string"
  );
}
