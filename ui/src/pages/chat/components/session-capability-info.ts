import { html, nothing } from "lit";
import type { SessionCapabilityStatus } from "../../../api/types.ts";
import type { SessionMenuData } from "../../../components/session-menu-actions.ts";
import { t } from "../../../i18n/index.ts";

export type PromotionActionKind = "promote-session" | "cancel-promotion" | "check-promotion";

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

/** Permissions from the projection only: turn scope, restrictions and session messaging. */
export function capabilityPermissionLabels(status: SessionCapabilityStatus | undefined): string[] {
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
  const send = status.capabilities.sessionsSend;
  return [
    ...scope,
    ...status.effectiveRestrictions.map(capabilityCodeLabel),
    t(
      `${KEY}.permission.${send === "allowed" ? "sessionsSendAllowed" : send === "denied" ? "sessionsSendDenied" : "sessionsSendUnknown"}`,
    ),
    ...(status.historicalOrigin === "delegated" && status.effectiveClass === "ordinary"
      ? [t(`${KEY}.permission.originDelegated`)]
      : []),
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

type CapabilityDetailsProps = {
  id: string;
  open: boolean;
  session: SessionMenuData;
  /** The badge words: shown again when only the badge carries an in-flight or refused outcome. */
  capabilityLabel: string;
  actionAllowed: (kind: PromotionActionKind) => boolean;
  onAction: (kind: PromotionActionKind) => void;
  onKeydown: (event: KeyboardEvent) => void;
};

/** Promote, cancel or check. Standard sessions have nothing to promote and get no button. */
function renderCapabilityActions(props: CapabilityDetailsProps) {
  const status = props.session.capabilityStatus;
  const pending = status?.promotionState === "pending";
  const button = (kind: PromotionActionKind, label: string, primary = false) => html`<button
    class=${`btn btn--sm${primary ? " primary" : ""} session-capability-details__action`}
    type="button"
    data-promotion-action=${kind}
    ?disabled=${!props.actionAllowed(kind)}
    @click=${() => props.onAction(kind)}
  >
    ${t(`${KEY}.info.${label}`)}
  </button>`;
  // Cancel needs the projected cancel authority; without it a pending row offers nothing.
  const actions = [
    ...(pending && status.canCancel ? [button("cancel-promotion", "cancel")] : []),
    ...(status && !pending && status.effectiveClass !== "ordinary"
      ? [button("promote-session", "promote", true)]
      : []),
    ...(props.session.promotionUncertain ? [button("check-promotion", "check")] : []),
  ];
  return actions.length
    ? html`<div class="session-capability-details__actions">${actions}</div>`
    : nothing;
}

/** The info bubble: short labelled facts from the projection, then the promotion buttons. */
export function renderSessionCapabilityDetails(props: CapabilityDetailsProps) {
  const { session } = props;
  const status = session.capabilityStatus;
  const transient = session.promotionBusy || session.promotionUncertain || session.promotionDenied;
  const states = [
    ...capabilityStateLabels(status),
    ...(transient ? [props.capabilityLabel] : []),
    ...(session.promotionMessage ? [session.promotionMessage] : []),
  ];
  const offersPromote =
    status && status.promotionState !== "pending" && status.effectiveClass !== "ordinary";
  const why = offersPromote
    ? [
        ...(session.promotionDisabledReason ? [session.promotionDisabledReason] : []),
        ...capabilityDisabledLabels(status),
        ...(!session.key || !session.sessionId || !status.lifecycleRevision
          ? [t(`${KEY}.unavailable`)]
          : []),
      ]
    : [];
  const row = (label: string, values: string[]) => {
    const unique = [...new Set(values)];
    return unique.length
      ? html`<dt>${t(`${KEY}.info.${label}`)}</dt>
          <dd>
            ${
              unique.length === 1
                ? unique[0]
                : html`<ul>
                    ${unique.map((value) => html`<li>${value}</li>`)}
                  </ul>`
            }
          </dd>`
      : nothing;
  };
  return html`<div
    id=${props.id}
    class="session-capability-details"
    role="region"
    aria-label=${t(`${KEY}.details`)}
    ?hidden=${!props.open}
    @keydown=${props.onKeydown}
  >
    <dl class="session-capability-details__facts">
      ${row("type", [capabilityTypeLabel(status)])}
      ${row("permissions", capabilityPermissionLabels(status))} ${row("status", states)}
      ${row("why", why)}
    </dl>
    ${renderCapabilityActions(props)}
  </div>`;
}
