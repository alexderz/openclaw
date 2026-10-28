import {
  MessageInjectionAcceptedUnconfirmedError,
  withMessageInjectionAdmission,
} from "../../auto-reply/reply/message-injection-authority.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { labelRuntimeContextText } from "../../llm/types.js";
import type { CliBackendMessageInjection } from "../../plugins/cli-backend.types.js";
import { isHostGeneratedInputProvenance } from "../../sessions/input-provenance.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import { cliBackendLog } from "./log.js";

/** One host adapter owns final input admission and accepted transcript custody. */
export function createSteeredCliMessageInjection(params: {
  getInjection: () => CliBackendMessageInjection | undefined;
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  cwd: string;
}): ReplyBackendMessageInjectionV2 {
  const queueMessage = async (
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    assertInjectionCurrent: () => void,
    prepareCurrent?: () => Promise<void>,
  ) => {
    const injection = params.getInjection();
    if (!injection) {
      throw new Error("CLI plugin runtime does not accept input during its turn.");
    }
    return await queueSteeredCliUserTurn(
      (message) =>
        injection.queueMessage(
          text,
          async (submit) => {
            let submitted = false;
            try {
              await runWithAgentToolSourceExecutionScope(params.assertCurrent, async () => {
                await withMessageInjectionAdmission(prepareCurrent, () => {
                  // The same worker-backed admission owns source checks and native stdin.
                  assertInjectionCurrent();
                  params.assertCurrent();
                  submit();
                  submitted = true;
                });
              });
            } catch (cause) {
              // Outer source cleanup can fail after native owns input, just like admission cleanup.
              if (submitted) {
                throw new MessageInjectionAcceptedUnconfirmedError({ cause });
              }
              throw cause;
            }
          },
          steeredInputOptions(message, options),
        ),
      options,
      params.cwd,
    );
  };
  return {
    version: 2,
    isAvailable: () => !params.signal.aborted && params.getInjection()?.isAvailable() === true,
    queueMessage: (text, options, assertInjectionCurrent) =>
      queueMessage(text, options, assertInjectionCurrent),
    queueMessageAsync: (text, options, preparation) =>
      queueMessage(text, options, preparation.assertCurrent, preparation.prepareCurrent),
  };
}

/** Each steered input carries its own origin and private context, never the running turn's. */
function steeredInputOptions(
  message: PersistedUserTurnMessage | undefined,
  options: ReplyBackendQueueMessageOptions | undefined,
): Parameters<CliBackendMessageInjection["queueMessage"]>[2] {
  const context = options?.currentInboundContext;
  return {
    ...(isHostGeneratedInputProvenance(message?.provenance)
      ? { promptOrigin: "host" as const }
      : {}),
    ...(context
      ? {
          promptContext: {
            prependContext: labelRuntimeContextText(
              projectRuntimeContextFragments(
                context.fragments ?? [{ kind: "conversation-data", text: context.text }],
              ),
            ),
          },
        }
      : {}),
  };
}

/** Native acceptance owns replay safety; transcript settlement releases input custody. */
async function queueSteeredCliUserTurn(
  inject: (message: PersistedUserTurnMessage | undefined) => Promise<void>,
  options: ReplyBackendQueueMessageOptions | undefined,
  cwd: string,
): Promise<ReplyBackendQueueMessageResult | undefined> {
  let accepted = false;
  let failure: Error | undefined;
  let result: ReplyBackendQueueMessageResult | undefined;
  const recorder = options?.userTurnTranscriptRecorder;
  try {
    // Resolve before the native write: a recorder failure must reject, not lose, the input.
    await inject(await recorder?.resolveMessage());
    accepted = true;
    options?.onQueueAccepted?.(true);
    if (recorder && !recorder.hasPersisted() && !recorder.isBlocked()) {
      const persisted = await recorder.persistApproved({ cwd });
      if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
        // Native owns the input, but an absent receipt does not prove write rejection.
        // Suppress outer fallback persistence without canceling independent active work.
        recorder.markBlocked();
        result = {
          transcriptCommit: "unconfirmed",
          errorMessage: "steered CLI user turn transcript commitment could not be confirmed",
        };
      }
    }
  } catch (error) {
    failure = toErrorObject(error, "CLI steering failed.");
  }
  try {
    // This receipt is terminal even when persistence failed; the registry retains
    // accepted-input disposition without replaying or canceling an unconfirmed turn.
    options?.onQueueSettled?.();
  } catch (error) {
    failure ??= toErrorObject(error, "CLI steering completion observer failed.");
  }
  if (failure) {
    if (!accepted) {
      throw failure;
    }
    // Completion observers can throw too. Never downgrade native acceptance to rejection.
    const errorMessage = `steered CLI user turn was not settled: ${formatErrorMessage(failure)}`;
    cliBackendLog.warn(errorMessage);
    return { transcriptCommit: "unconfirmed", errorMessage };
  }
  return result;
}
