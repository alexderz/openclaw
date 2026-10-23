/**
 * The subagent registry keeps the runs in which a promoted session was spawned. Once the session
 * row is a root, those settled runs are marked handed off so the former parent stops counting,
 * waiting on, cascading into or nesting the promoted session's own work. The session row is the
 * authority; this bookkeeping follows it and is repaired at startup if a crash interrupts it.
 */
export async function releasePromotedSessionFromSpawner(params: {
  childSessionKey: string;
  childSessionId?: string;
}): Promise<{ marked: number; unsettled: number }> {
  const { releaseSubagentChildToRoot } =
    await import("../agents/subagents/registry/subagent-registry.js");
  return await releaseSubagentChildToRoot(params);
}
