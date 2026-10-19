import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionPromotion = {
  chat: {
    sessionHeader: {
      promotion: {
        ordinary: "Ordinary",
        ordinaryLimited: "Ordinary · policy-limited",
        ordinaryDirectTurns: "Ordinary · your chat turns only",
        promotedForOther: "Promoted for someone else · your turns limited",
        pending: "Promotion pending",
        denied: "Promotion denied · limited",
        uncertain: "Promotion result unknown · check status",
        notAllowed: "Promotion isn't allowed for this session",
        notAllowedReason: "Promotion isn't allowed for this session: {reason}",
        action: "Promote to ordinary session…",
        cancel: "Cancel pending promotion…",
        check: "Check promotion status",
        details: "Session capability details",
        origin: "Originally delegated; provenance is retained.",
        scope:
          "Ordinary capabilities apply to the requesting person's direct chat turns. Completion wakes, automation, messages from other sessions and other people's turns stay limited, as do plugin agent harnesses (such as Codex), background and compaction runs, and the sub-agent spawn limit.",
        explanation:
          "Promotion keeps this conversation, history and board. It takes effect only after accepted work settles; it does not stop work or grant tools beyond ordinary policy.",
        send: "Session messaging: {status}",
        busy: "Checking or submitting promotion…",
        unavailable:
          "Promotion is unavailable: current authorization and session revision are required.",
        confirmTitle: "Promote {session}?",
        confirm: "Promote session",
        cancelTitle: "Cancel promotion for {session}?",
        cancelConfirm: "Cancel promotion",
        cancelUnavailable:
          "Cancelling this pending promotion is not available to you, or its identity changed. Check status.",
        cancelExplanation:
          "Cancel only the pending handoff. Running work is not stopped and this conversation is not deleted.",
        checked: "Status refreshed from the Gateway.",
        stale: "Session or authorization changed. Check status before acting.",
      },
    },
  },
} satisfies TranslationMap;

export const registerSessionPromotionEnglish = Object.assign(
  () =>
    Object.assign(en.chat.sessionHeader.promotion, enSessionPromotion.chat.sessionHeader.promotion),
  { catalog: enSessionPromotion },
);
