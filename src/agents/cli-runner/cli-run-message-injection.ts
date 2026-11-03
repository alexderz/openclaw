import { MessageInjectionTargetUnavailableError } from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type CliRunMessageInjection = {
  sessionId: string;
  injection: ReplyBackendMessageInjectionV2;
};

// Lazy imports and reloads in one Gateway process must retain the same run sinks.
const cliRunMessageInjections = resolveGlobalSingleton(
  Symbol.for("openclaw.cliRunMessageInjections"),
  () => new Map<string, CliRunMessageInjection>(),
);

/** Offer one CLI run's guarded input sink to its native owner placeholder while the run lasts. */
export function registerCliRunMessageInjection(params: {
  runId: string;
  sessionId: string;
  injection: ReplyBackendMessageInjectionV2;
}): () => void {
  const entry: CliRunMessageInjection = {
    sessionId: params.sessionId,
    injection: params.injection,
  };
  cliRunMessageInjections.set(params.runId, entry);
  return () => {
    if (cliRunMessageInjections.get(params.runId) === entry) {
      cliRunMessageInjections.delete(params.runId);
    }
  };
}

/**
 * Session lanes, agent commands and cron hand a turn to the CLI through a placeholder
 * native owner, which is what sessions_send and completion wakes target. Forward its
 * guarded injection to the same run's CLI sink; that sink still revalidates the run and
 * source authority at the native write. Without a live sink the input stays unaccepted
 * and keeps its followup fallback.
 */
export function createCliHandoffMessageInjection(params: {
  runId: string;
  sessionId: string;
  isStopped: () => boolean;
}): {
  injection: ReplyBackendMessageInjectionV2;
  /** The placeholder advertises guarded input only while its CLI turn can take it. */
  current: () => ReplyBackendMessageInjectionV2 | undefined;
} {
  const resolve = () => {
    const entry = cliRunMessageInjections.get(params.runId);
    return entry && entry.sessionId === params.sessionId && !params.isStopped()
      ? entry.injection
      : undefined;
  };
  const require = () => {
    const injection = resolve();
    if (!injection) {
      throw new MessageInjectionTargetUnavailableError(
        "The CLI run does not accept input during its turn.",
      );
    }
    return injection;
  };
  const injection: ReplyBackendMessageInjectionV2 = {
    version: 2,
    isAvailable: () => resolve()?.isAvailable() === true,
    queueMessage: async (text, options, assertCurrent, authorityKind) =>
      await require().queueMessage(text, options, assertCurrent, authorityKind),
    queueMessageAsync: async (text, options, preparation, authorityKind) => {
      const target = require();
      return target.queueMessageAsync
        ? await target.queueMessageAsync(text, options, preparation, authorityKind)
        : await target.queueMessage(text, options, preparation.assertCurrent, authorityKind);
    },
  };
  // Before the turn takes input (startup, prompt hook) or for a CLI without a sink, a
  // guarded caller sees no guarded capability and keeps its unguarded fallback path.
  return { injection, current: () => (injection.isAvailable() ? injection : undefined) };
}
