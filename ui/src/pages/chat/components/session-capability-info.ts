import type { SessionCapabilityStatus } from "../../../api/types.ts";
import type { SessionMenuData } from "../../../components/session-menu-actions.ts";
import type { PromotionMenuActionKind } from "../../../components/session-promotion-menu.ts";
import { t } from "../../../i18n/index.ts";

export type PromotionActionKind = PromotionMenuActionKind;

const KEY = "chat.sessionHeader.promotion";

/** Short labels for the Gateway's reason, blocker and restriction codes. */
const CODE_LABELS: Record<string, string> = {
  "current-human-authorization-required": "reason.authorization",
  "stale-or-invalid-promotion": "reason.stale",
  "promotion-pending": "reason.pending",
  "promotion-activated": "reason.activated",
  "promotion-blocked": "reason.blocked",
  "unsupported-target:unsupported-key": "reason.unsupportedKey",
  "unsupported-target:incognito": "reason.incognito",
  "unsupported-target:acp-session": "reason.acp",
  "unsupported-target:not-delegated": "reason.notDelegated",
  "unsupported-target:dashboard-only": "reason.dashboardOnly",
  "unsupported-target:no-revision": "reason.noRevision",
  "quiescence-and-current-human-revalidation-required": "state.waitingFor",
  "current-role-grants-resource-policy-and-sandbox-still-apply": "permission.roleAndSandbox",
  // Restriction origins (`ToolRestrictionOrigin`) the projection sends in effectiveRestrictions.
  role: "permission.limitedByRole",
  "agent-policy": "permission.limitedByAgentPolicy",
  "inherited-limit": "permission.limitedByParent",
  "subagent-layer": "permission.limitedBySubagentLayer",
  sandbox: "permission.limitedBySandbox",
  other: "permission.limitedByOther",
};

/** An unmapped code is shown as sent, so a new Gateway reason is never hidden or reworded. */
export function capabilityCodeLabel(code: string): string {
  const key = CODE_LABELS[code];
  return key ? t(`${KEY}.${key}`) : code;
}

export function capabilityTypeLabel(status: SessionCapabilityStatus | undefined): string {
  if (!status || status.effectiveClass === "unknown") {
    return t(`${KEY}.type.unknown`);
  }
  if (status.promotionState === "pending") {
    return t(`${KEY}.type.pending`);
  }
  const direct = status.classScope === "requesting-human-direct-turns";
  if (status.effectiveClass === "delegated") {
    return t(`${KEY}.type.${direct ? "limitedPromotedOther" : "limited"}`);
  }
  return t(`${KEY}.type.${direct ? "standardDirect" : "standard"}`);
}

/** Which turns run ordinary or delegated, from the projection; tool limits live in Permissions. */
export function capabilityScopeLabels(status: SessionCapabilityStatus | undefined): string[] {
  if (!status || status.effectiveClass === "unknown") {
    return [];
  }
  const direct = status.classScope === "requesting-human-direct-turns";
  const scope =
    status.effectiveClass === "ordinary"
      ? direct
        ? [t(`${KEY}.permission.directTurnsStandard`), t(`${KEY}.permission.otherTurnsLimited`)]
        : [t(`${KEY}.permission.allTurnsStandard`)]
      : [t(`${KEY}.permission.${direct ? "yourTurnsLimited" : "allTurnsLimited"}`)];
  return [
    ...scope,
    ...(status.historicalOrigin === "delegated" &&
    status.effectiveClass === "ordinary" &&
    !status.promotedFrom
      ? [t(`${KEY}.permission.originDelegated`)]
      : []),
  ];
}

/** Restriction origins and session messaging as the row projects them, in plain words. */
export function capabilityRestrictionLabels(status: SessionCapabilityStatus | undefined): string[] {
  if (!status || status.effectiveClass === "unknown") {
    return [];
  }
  const send = status.capabilities.sessionsSend;
  return [
    ...status.effectiveRestrictions.map(capabilityCodeLabel),
    t(
      `${KEY}.permission.${send === "allowed" ? "sessionsSendAllowed" : send === "denied" ? "sessionsSendDenied" : "sessionsSendUnknown"}`,
    ),
  ];
}

/** Where a promoted root came from and when: history, shown in place of the delegated origin. */
export function capabilityOriginLabels(session: SessionMenuData): string[] {
  const from = session.capabilityStatus?.promotedFrom;
  if (!from) {
    return [];
  }
  const date = new Date(from.at).toLocaleDateString();
  return [
    session.promotedFromLabel
      ? t(`${KEY}.info.promotedFrom`, { parent: session.promotedFromLabel, date })
      : t(`${KEY}.info.promotedOn`, { date }),
  ];
}

/** The promotion lifecycle, plus what a pending handoff still waits for. Empty when settled. */
export function capabilityStateLabels(status: SessionCapabilityStatus | undefined): string[] {
  const state = status?.promotionState;
  if (!status || !state || state === "none") {
    return [];
  }
  return [t(`${KEY}.state.${state}`), ...status.pendingBlockers.map(capabilityCodeLabel)];
}

/**
 * Why Promote is unavailable. Lifecycle codes the status line already shows are left out, so a
 * pending session does not also read "Already pending".
 */
export function capabilityDisabledLabels(status: SessionCapabilityStatus | undefined): string[] {
  const shown = status?.promotionState ? `promotion-${status.promotionState}` : "";
  return [
    ...new Set(
      (status?.disabledReasons ?? []).filter((code) => code !== shown).map(capabilityCodeLabel),
    ),
  ];
}

/**
 * The Class facts the info bubble used to show, label key first: type, origin, scope, status and
 * why promotion is unavailable. Empty values are left out.
 */
export function capabilityFacts(
  session: SessionMenuData,
  capabilityLabel: string,
): Array<[label: string, values: string[]]> {
  const status = session.capabilityStatus;
  const transient = session.promotionBusy || session.promotionUncertain || session.promotionDenied;
  const states = [
    ...capabilityStateLabels(status),
    ...(transient ? [capabilityLabel] : []),
    ...(session.promotionMessage ? [session.promotionMessage] : []),
  ];
  const pending = status?.promotionState === "pending";
  const offersPromote = status && !pending && status.effectiveClass !== "ordinary";
  // A pending row this viewer may not cancel still says why, from the projected reasons.
  const why =
    pending && !status.canCancel
      ? capabilityDisabledLabels(status)
      : offersPromote
        ? [
            ...(session.promotionDisabledReason ? [session.promotionDisabledReason] : []),
            ...capabilityDisabledLabels(status),
            ...(!session.key || !session.sessionId || !status.lifecycleRevision
              ? [t(`${KEY}.unavailable`)]
              : []),
          ]
        : [];
  const rows: Array<[string, string[]]> = [
    ["type", [capabilityTypeLabel(status)]],
    ["origin", capabilityOriginLabels(session)],
    ["scope", capabilityScopeLabels(status)],
    ["status", states],
    ["why", why],
  ];
  return rows.flatMap(([label, values]) => {
    const unique = [...new Set(values)];
    return unique.length ? [[t(`${KEY}.info.${label}`), unique] as [string, string[]]] : [];
  });
}
