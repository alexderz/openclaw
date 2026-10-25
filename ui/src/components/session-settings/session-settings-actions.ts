import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { SessionManagementAction, SessionMenuData } from "../session-menu-actions.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "../session-owner-chip.ts";
import { promotionActionAllowed, type PromotionMenuActionKind } from "../session-promotion-menu.ts";

/** What a sheet action may ask its host to run; hosts already handle every one of these. */
export type SessionSettingsHostAction =
  | SessionManagementAction
  | { [Kind in PromotionMenuActionKind]: { kind: Kind } }[PromotionMenuActionKind];

/** The session and host facts an action needs to decide whether, and how, it applies. */
export type SessionSettingsActionTarget = {
  session: SessionMenuData;
  row: GatewaySessionRow | undefined;
  groups: readonly string[];
  currentOwner: SessionCreatedActor | null;
  owners: { options: SessionOwnerOption[]; loading: boolean };
  archiveAllowed: boolean;
  /** Host gating by action kind, as the session menus use it. */
  disabledReasons: Partial<Record<string, string>>;
  connected: boolean;
  /** Whether the host can re-check an uncertain promotion (the chat header can). */
  promotionCheck: boolean;
  dispatch: (action: SessionSettingsHostAction) => void;
};

export type SessionSettingsActionView = {
  label: string;
  /** One quiet line under the control. */
  note?: string;
  disabledReason?: string;
  primary?: boolean;
  /** The sheet closes first, so a confirm dialog or inline rename is not hidden behind it. */
  closesSheet?: boolean;
  /** A button runs this; omitted when `control` renders its own input. */
  run?: () => void;
  /** Inline control (a picker) instead of a button; it dispatches by itself. */
  control?: (id: string, disabled: boolean) => TemplateResult;
};

/**
 * One entry in the Actions section. `resolve` returns null when the action does not apply, so
 * the sheet never needs to know what an action is: later actions (capability grants, peer
 * spawns) register a descriptor and appear without touching the sheet.
 */
export type SessionSettingsActionDescriptor = {
  id: string;
  /** Ascending; built-ins use multiples of 10. */
  order: number;
  resolve: (target: SessionSettingsActionTarget) => SessionSettingsActionView | null;
};

const KEY = "chat.sessionSettings.actions";

function promotionAction(target: SessionSettingsActionTarget): SessionSettingsActionView | null {
  const { session } = target;
  const status = session.capabilityStatus;
  const pending = status?.promotionState === "pending";
  // Same offer as the menus: an ordinary or unknown session has nothing to promote.
  if (!pending && (!status || status.effectiveClass === "ordinary")) {
    return null;
  }
  const kind: PromotionMenuActionKind = pending ? "cancel-promotion" : "promote-session";
  const allowed = promotionActionAllowed(session, kind);
  return {
    label: t(`chat.sessionHeader.promotion.${pending ? "cancel" : "action"}`),
    primary: !pending,
    closesSheet: true,
    disabledReason: allowed
      ? undefined
      : (session.promotionDisabledReason ??
        (pending
          ? t("chat.sessionHeader.promotion.cancelUnavailable")
          : t("chat.sessionHeader.promotion.unavailable"))),
    run: () => target.dispatch({ kind }),
  };
}

function checkPromotionAction(target: SessionSettingsActionTarget) {
  if (!target.promotionCheck || !target.session.promotionUncertain) {
    return null;
  }
  return {
    label: t("chat.sessionHeader.promotion.check"),
    disabledReason: promotionActionAllowed(target.session, "check-promotion")
      ? undefined
      : t("chat.sessionHeader.promotion.busy"),
    run: () => target.dispatch({ kind: "check-promotion" }),
  } satisfies SessionSettingsActionView;
}

function reason(target: SessionSettingsActionTarget, kind: string, extra?: string) {
  return (
    target.disabledReasons[kind] ??
    extra ??
    (target.connected ? undefined : t("sessionsView.actionRequiresConnection"))
  );
}

function ownerAction(target: SessionSettingsActionTarget): SessionSettingsActionView {
  const current = target.currentOwner;
  const currentId = current?.identity?.id ?? current?.id;
  const value = current && currentId ? `${current.type}:${currentId}` : "";
  return {
    label: t(`${KEY}.owner`),
    disabledReason: reason(target, "assign-owner"),
    note: target.owners.loading ? t("common.loading") : undefined,
    control: (id, disabled) =>
      html`<select
        id=${id}
        class="session-settings__select"
        ?disabled=${disabled}
        @change=${(event: Event) => {
          const selected = (event.target as HTMLSelectElement).value;
          const separator = selected.indexOf(":");
          const type = selected.slice(0, separator);
          const ownerId = selected.slice(separator + 1);
          if (selected && selected !== value && (type === "human" || type === "agent")) {
            target.dispatch({ kind: "assign-owner", owner: { type, id: ownerId } });
          }
        }}
      >
        ${value ? nothing : html`<option value="" selected>${t(`${KEY}.noOwner`)}</option>`}
        ${target.owners.options.map(
          (owner) =>
            html`<option
              value=${`${owner.type}:${owner.id}`}
              ?selected=${`${owner.type}:${owner.id}` === value}
            >
              ${owner.label ?? owner.id}
            </option>`,
        )}
      </select>`,
  };
}

function groupAction(target: SessionSettingsActionTarget): SessionSettingsActionView | null {
  if (target.session.isChild === true) {
    return null;
  }
  const category = target.session.category;
  const groups = [...new Set([...target.groups, ...(category ? [category] : [])])];
  return {
    label: t(`${KEY}.group`),
    disabledReason: reason(target, "move-to-group"),
    control: (id, disabled) =>
      html`<select
        id=${id}
        class="session-settings__select"
        ?disabled=${disabled}
        @change=${(event: Event) => {
          const select = event.target as HTMLSelectElement;
          const selected = select.value;
          if (select.selectedOptions[0]?.dataset.newGroup !== undefined) {
            // Restore the shown value; the host's own dialog asks for the name.
            select.value = category ?? "";
            target.dispatch({ kind: "new-group" });
          } else if (selected !== (category ?? "")) {
            target.dispatch({ kind: "move-to-group", category: selected || null });
          }
        }}
      >
        <option value="" ?selected=${!category}>${t(`${KEY}.noGroup`)}</option>
        ${groups.map(
          (group) => html`<option value=${group} ?selected=${group === category}>${group}</option>`,
        )}
        <option value="" data-new-group>${t(`${KEY}.newGroup`)}</option>
      </select>`,
  };
}

const BUILT_IN_ACTIONS: SessionSettingsActionDescriptor[] = [
  { id: "promotion", order: 10, resolve: promotionAction },
  { id: "check-promotion", order: 20, resolve: checkPromotionAction },
  {
    id: "rename",
    order: 30,
    resolve: (target) => ({
      label: t(`${KEY}.rename`),
      closesSheet: true,
      disabledReason: reason(target, "rename"),
      run: () => target.dispatch({ kind: "rename" }),
    }),
  },
  { id: "owner", order: 40, resolve: ownerAction },
  { id: "group", order: 50, resolve: groupAction },
  {
    id: "pin",
    order: 60,
    resolve: (target) =>
      (target.session.pinnable ?? target.session.isChild !== true) && !target.session.archived
        ? {
            label: t(`${KEY}.${target.session.pinned ? "unpin" : "pin"}`),
            disabledReason: reason(target, "toggle-pin"),
            run: () => target.dispatch({ kind: "toggle-pin" }),
          }
        : null,
  },
  {
    id: "archive",
    order: 70,
    resolve: (target) =>
      target.session.archived || target.archiveAllowed
        ? {
            label: t(`${KEY}.${target.session.archived ? "unarchive" : "archive"}`),
            closesSheet: !target.session.archived,
            disabledReason: reason(
              target,
              "toggle-archived",
              target.session.archiving ? t("common.loading") : undefined,
            ),
            run: () => target.dispatch({ kind: "toggle-archived" }),
          }
        : null,
  },
];

const registeredActions = new Map<string, SessionSettingsActionDescriptor>();

const BUILT_IN_ACTION_IDS: ReadonlySet<string> = new Set(BUILT_IN_ACTIONS.map(({ id }) => id));

/**
 * Adds an action to every Session settings sheet; returns the unregister function. Built-in ids
 * are reserved: Promote and the other built-ins carry the menus' permission checks, and a
 * registration must not be able to swap them out.
 */
export function registerSessionSettingsAction(
  descriptor: SessionSettingsActionDescriptor,
): () => void {
  if (BUILT_IN_ACTION_IDS.has(descriptor.id)) {
    throw new Error(`Session settings action id "${descriptor.id}" is reserved`);
  }
  registeredActions.set(descriptor.id, descriptor);
  return () => {
    if (registeredActions.get(descriptor.id) === descriptor) {
      registeredActions.delete(descriptor.id);
    }
  };
}

/** The actions that apply to this target, built-in and registered, sorted by `order`. */
export function resolveSessionSettingsActions(
  target: SessionSettingsActionTarget,
): Array<SessionSettingsActionView & { id: string }> {
  const descriptors = new Map(BUILT_IN_ACTIONS.map((descriptor) => [descriptor.id, descriptor]));
  for (const [id, descriptor] of registeredActions) {
    descriptors.set(id, descriptor);
  }
  return [...descriptors.values()]
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .flatMap((descriptor) => {
      const view = descriptor.resolve(target);
      return view ? [{ ...view, id: descriptor.id }] : [];
    });
}
