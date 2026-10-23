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
        details: "Session info",
        sidebar: {
          limited: "Limited session",
          pending: "Promotion pending",
        },
        explanation:
          "Promotion keeps this conversation, history and board, and turns it into a standard dashboard session: every turn runs under ordinary policy, it leaves its parent and its own subagents count from zero. It takes effect only after accepted work settles; it does not stop work or grant tools beyond ordinary policy.",
        info: {
          type: "Type",
          origin: "Origin",
          promotedFrom: "Promoted from {parent} on {date}",
          promotedOn: "Promoted on {date}",
          permissions: "Permissions",
          status: "Status",
          why: "Why not",
          promote: "Promote",
          cancel: "Cancel promotion",
          check: "Check status",
        },
        type: {
          standard: "Standard",
          standardDirect: "Standard · your turns only",
          limited: "Limited (delegated)",
          limitedPromotedOther: "Limited · promoted for someone else",
          pending: "Pending promotion",
          unknown: "Unknown",
        },
        permission: {
          allTurnsStandard: "Standard: every turn",
          allTurnsLimited: "Delegated limits: every turn",
          yourTurnsLimited: "Delegated limits: your turns (standard for the requester)",
          directTurnsStandard: "Standard: your direct chat turns",
          otherTurnsLimited: "Limited: wakes, automation, other sessions and people",
          roleAndSandbox: "Your role, resource policy and sandbox still apply",
          sessionsSendAllowed: "Session messaging: allowed",
          sessionsSendDenied: "Session messaging: denied",
          sessionsSendUnknown: "Session messaging: checked when used",
          originDelegated: "Started as delegated",
        },
        state: {
          pending: "Starts on the next fresh turn",
          activated: "Promoted",
          revoked: "Promotion revoked",
          blocked: "Blocked",
          waitingFor: "Waiting for running work to settle and an access re-check",
        },
        reason: {
          authorization: "Needs your current authorization",
          stale: "Promotion record is stale or invalid",
          pending: "Already pending",
          activated: "Already promoted",
          blocked: "Promotion is blocked",
          unsupportedKey: "This kind of session can't be promoted",
          incognito: "Incognito sessions can't be promoted",
          acp: "External (ACP) sessions can't be promoted",
          notDelegated: "Already a standard session",
          dashboardOnly: "Only dashboard sessions, unless you're an admin",
          noRevision: "Session has no revision yet",
        },
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
