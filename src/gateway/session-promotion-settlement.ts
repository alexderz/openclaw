import { listAgentIds } from "../agents/agent-roster.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { decodeSessionPromotion } from "../sessions/session-promotion-state.js";
import { onSessionWorkSettled } from "../sessions/session-work-settlement.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { activateSessionPromotionAfterSettlement } from "./server-methods/sessions-promotion-activation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  isSessionPromotionPending,
  markSessionPromotionPending,
} from "./session-promotion-pending-keys.js";

const SETTLE_DELAY_MS = 250;

/**
 * Owner-scheduled promotion attempts. When a work owner releases custody of a durable session that
 * holds a pending promotion intent, consume that intent through the shared activation helper. No
 * polling: attempts are coalesced per key and only follow an owner release of a pending key, plus
 * one startup pass for intents that were already quiet when the previous process stopped.
 */
export function startSessionPromotionSettlement(
  context: GatewayRequestContext,
  log: { warn: (message: string) => void },
  delayMs = SETTLE_DELAY_MS,
): { stop: () => void } {
  const params = { context, log };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const dirty = new Set<string>();
  let stopped = false;
  const attempt = async (key: string) => {
    if (stopped) {
      return;
    }
    if (running.has(key)) {
      dirty.add(key);
      return;
    }
    running.add(key);
    try {
      await activateSessionPromotionAfterSettlement({ context: params.context, sessionKey: key });
    } catch (error) {
      params.log.warn(
        `session promotion settlement deferred: ${error instanceof Error ? error.name : "error"}`,
      );
    } finally {
      running.delete(key);
      if (dirty.delete(key)) {
        schedule(key);
      }
    }
  };
  const schedule = (key: string) => {
    if (stopped || timers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(key);
      void attempt(key);
    }, delayMs);
    timer.unref?.();
    timers.set(key, timer);
  };
  // The attempt itself reads the row and returns at once without a pending intent.
  const isPromotionKey = (identity: string) =>
    !isIncognitoSessionKey(identity) && parseAgentSessionKey(identity);
  const unsubscribe = onSessionWorkSettled((identities) => {
    for (const identity of identities) {
      if (isPromotionKey(identity) && isSessionPromotionPending(identity)) {
        schedule(identity);
      }
    }
  });
  // A restart leaves no owner release to wake an intent that was already quiet. Read each agent
  // store once, off the main thread, and schedule one ordinary attempt per pending intent: the
  // attempt consumes only the restored original basis and stays pending when it cannot prove it.
  const reconcileAtStartup = async () => {
    const cfg = params.context.getRuntimeConfig();
    for (const agentId of listAgentIds(cfg)) {
      if (stopped) {
        return;
      }
      try {
        const entries = await readSessionEntrySummariesInWorker({
          agentId,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
        });
        for (const { sessionKey, entry } of entries) {
          if (
            isPromotionKey(sessionKey) &&
            decodeSessionPromotion(entry.sessionPromotion)?.state === "pending"
          ) {
            markSessionPromotionPending(sessionKey);
            schedule(sessionKey);
          }
        }
      } catch (error) {
        params.log.warn(
          `session promotion startup settlement skipped a store: ${error instanceof Error ? error.name : "error"}`,
        );
      }
    }
  };
  void reconcileAtStartup().catch((error: unknown) => {
    params.log.warn(
      `session promotion startup settlement skipped: ${error instanceof Error ? error.name : "error"}`,
    );
  });
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
