/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  PENDING_REQUEST_ID,
  promotionProjection,
  type PromotionFixtureKind,
} from "../../lib/sessions/session-promotion.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({
  showConfirmDialog: vi.fn(async () => true),
}));

function promotionFixture(
  request = vi.fn(async () => ({})),
  kind: PromotionFixtureKind = "authorized-none",
) {
  const session = {
    key: "agent:main:current",
    sessionId: "session-current",
    kind: "direct",
    promotion: promotionProjection(kind),
  } satisfies GatewaySessionRow;
  const result = sessionsResult([session], 1);
  // A refreshed Gateway read yields a new projection object for the current row.
  const refresh = vi.fn(async () => {
    const row = result.sessions[0]!;
    row.promotion = { ...row.promotion! };
  });
  const sessions = createSessionCapabilityFixture({ state: { result }, refresh });
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions,
  });
  fixture.state.settings = loadSettings();
  return { ...fixture, session, result, refresh, request };
}

it("preserves canonical identity and current promotion metadata in header memo", async () => {
  const { pane, state, session } = promotionFixture();
  const container = document.body.appendChild(document.createElement("div"));
  const draw = () =>
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
  draw();
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  expect(menu.session.key).toBe(session.key);
  expect(menu.session.capabilityStatus).toEqual(session.promotion);
  session.promotion = { ...session.promotion!, lifecycleRevision: "rev-two" };
  draw();
  await menu.updateComplete;
  expect(menu.session.capabilityStatus?.lifecycleRevision).toBe("rev-two");
  container.remove();
});

it("confirms the named target and sends only strict promotion identity fields", async () => {
  const { pane, session, request, refresh } = promotionFixture();
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(showConfirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: expect.stringContaining("current") }),
  );
  expect(request).toHaveBeenCalledWith("sessions.promote", {
    key: session.key,
    expectedSessionId: session.sessionId,
    expectedLifecycleRevision: "rev-one",
    requestId: expect.any(String),
    action: "request",
  });
  expect(refresh).toHaveBeenCalled();
  expect(session.promotion.effectiveClass).toBe("delegated");
});

it("lets an authorized viewer request again after a terminal revoke with a fresh request id", async () => {
  const { pane, session, request } = promotionFixture(undefined, "revoked-authorized");
  expect(session.promotion?.promotionState).toBe("revoked");
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).toHaveBeenCalledWith(
    "sessions.promote",
    expect.objectContaining({
      key: session.key,
      expectedLifecycleRevision: "rev-one",
      requestId: expect.any(String),
      action: "request",
    }),
  );
});

it("does not submit after confirmation cancellation or a changed revision", async () => {
  const { pane, session, request } = promotionFixture();
  vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).not.toHaveBeenCalled();
  vi.mocked(showConfirmDialog).mockImplementationOnce(async () => {
    session.promotion = { ...session.promotion, lifecycleRevision: "changed" };
    return true;
  });
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).not.toHaveBeenCalled();
});

it("requires a status check after an uncertain result rather than blind retry", async () => {
  const request = vi.fn(async () => {
    throw new Error("transport lost");
  });
  const { pane, session, refresh } = promotionFixture(request);
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).toHaveBeenCalledTimes(1);
  await pane.handleHeaderSessionAction({ kind: "check-promotion" }, session);
  expect(refresh).toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetTranscriptTestDom();
  vi.clearAllMocks();
});

describe("chat pane session menu boundary", () => {
  it("keeps unchanged menu children settled and reads current callbacks after a header refresh", async () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({ state: { groups: ["Projects"] } }),
    });
    state.settings = loadSettings();
    let session: GatewaySessionRow = {
      key: state.sessionKey,
      sessionId: "current",
      kind: "direct",
      label: "Current conversation",
      sharingRole: "owner",
    };
    const container = document.body.appendChild(document.createElement("div"));
    let workspace = createPaneHeaderWorkspaceFixture(state);
    const draw = () => {
      workspace = createPaneHeaderWorkspaceFixture(state);
      render(pane.renderPaneHeader(workspace, session, false, undefined, false, null), container);
    };
    draw();
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    const items = [...menu.querySelectorAll("wa-dropdown-item")];
    await Promise.all(items.map((item) => item.updateComplete));
    await menu.updateComplete;
    const updates = vi.spyOn(menu, "render");
    const itemUpdates = items.map((item) => vi.spyOn(item, "requestUpdate"));
    draw();
    await menu.updateComplete;
    expect(updates).not.toHaveBeenCalled();
    expect(itemUpdates.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "quick:panels:session-files" } },
      }),
    );
    expect(workspace.onToggleCollapsed).toHaveBeenCalledOnce();

    state.settings = { ...state.settings };
    session = { ...session };
    draw();
    await menu.updateComplete;
    expect(updates).not.toHaveBeenCalled();

    session = { ...session, label: "Updated conversation", pinned: true };
    draw();
    await menu.updateComplete;
    expect(updates).toHaveBeenCalledOnce();
    expect(menu.session.label).toBe("Updated conversation");
    expect(menu.session.pinned).toBe(true);
    state.settings = { ...state.settings, chatShowThinking: !state.settings.chatShowThinking };
    draw();
    await menu.updateComplete;
    expect(updates).toHaveBeenCalledTimes(2);
    expect(menu.querySelector('[value="view:reasoning"]')?.hasAttribute("checked")).toBe(
      state.settings.chatShowThinking,
    );
    const action = vi.spyOn(pane, "handleHeaderSessionAction").mockResolvedValue(undefined);
    menu
      .querySelector("wa-dropdown")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "toggle-pin" } } }));
    expect(action).toHaveBeenCalledWith({ kind: "toggle-pin" }, session);
    expect(action.mock.calls[0]?.[1]).toBe(session);
    state.applySettings = vi.fn();
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "view:tool-calls" } },
      }),
    );
    expect(state.applySettings).toHaveBeenCalledWith({
      chatShowToolCalls: !state.settings.chatShowToolCalls,
    });
  });

  it("keeps observed pane titles and renames with their conversations when agent selection changes", async () => {
    const primary: GatewaySessionRow = {
      key: "agent:main:dashboard:ledger",
      agentId: "main",
      sessionId: "ledger-session",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Ledger reconciliation",
    };
    const retained: GatewaySessionRow = {
      key: "agent:research:dashboard:verifier",
      agentId: "research",
      sessionId: "verifier-session",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Fresh pane isolation check",
    };
    const rows = [primary, retained];
    const { sessions, context, mount, emitGatewayEvent } = createMountedPanes(
      rows,
      "main",
      undefined,
      {
        "sessions.list": (_method, params) =>
          sessionsResult(
            rows.filter((row) => row.agentId === asOptionalRecord(params)?.agentId),
            1,
          ),
        "sessions.patch": (_method, params) => {
          const request = asOptionalRecord(params);
          expect(request?.key).toBe(primary.key);
          expect(request?.expectedSessionId).toBe(primary.sessionId);
          expect(request?.label).toBe("Reviewed ledger");
          rows[0] = { ...primary, label: "Reviewed ledger", updatedAt: 2 };
          return { ok: true, key: primary.key, entry: rows[0] };
        },
      },
    );
    await sessions.refresh({ agentId: "main", force: true });
    const ledger = mount(primary.key, "main");
    const verifier = mount(retained.key, "research");
    await Promise.all([ledger, verifier].map(refreshPane));
    const container = document.body.appendChild(document.createElement("div"));
    const title = (pane: TestChatPane) => {
      const presentation = sessions.presentation.result?.sessions.find(
        (row) => row.key === pane.sessionKey,
      );
      pane.presentationTitle = presentation
        ? resolveSessionDisplayName(pane.sessionKey, presentation)
        : undefined;
      render(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(pane.state),
          selectedChatSessionRow(pane.state),
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
      return container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
    };
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([primary.key]);
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("research");
    await sessions.refresh({ agentId: "research", force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([retained.key]);
    expect.soft(title(ledger)).toBe("Ledger reconciliation");
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("main");
    await sessions.refresh({ agentId: "main", force: true });
    const redraw = vi.spyOn(verifier, "requestUpdate");
    emitGatewayEvent("sessions.changed", {
      sessionKey: retained.key,
      agentId: "research",
      reason: "label",
      session: { ...retained, label: "Reviewed conversation", updatedAt: 2 },
    });
    expect(redraw).toHaveBeenCalled();
    expect.soft(title(verifier)).toBe("Reviewed conversation");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    expect(verifier.headerRenameValue).toBe("Reviewed conversation");
    verifier.cancelHeaderRename();
    expect(title(ledger)).toBe("Ledger reconciliation");

    const patch = vi.spyOn(sessions, "patch");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    ledger.headerRenameValue = "Reviewed ledger";
    ledger.commitHeaderRename();
    expect(patch).toHaveBeenCalledOnce();
    await patch.mock.results[0]?.value;
    expect(sessions.presentation.result?.sessions[0]?.label).toBe("Reviewed ledger");
    expect(title(ledger)).toBe("Reviewed ledger");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Reviewed ledger");
  });

  it("keeps reconnect presentation and catalog names ahead of incomplete pane metadata", () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    state.connected = false;
    pane.presentationTitle = "Retained conversation";
    const container = document.createElement("div");
    const row = {
      key: "agent:main:dashboard:retained",
      kind: "direct",
      derivedTitle: "Partial reconnect metadata",
    } satisfies GatewaySessionRow;
    const draw = (session: GatewaySessionRow | undefined, catalog = false) => {
      render(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          session,
          catalog,
          undefined,
          false,
          null,
        ),
        container,
      );
      return container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
    };
    expect(draw(undefined)).toBe("Retained conversation");
    expect(draw(row)).toBe("Retained conversation");
    expect(draw({ ...row, label: "Older scoped label" })).toBe("Retained conversation");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Retained conversation");
    pane.catalogSession = {
      threadId: "catalog",
      name: "Imported conversation",
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    expect(draw(row, true)).toBe("Imported conversation");
    pane.presentationTitle = undefined;
    expect(draw(row)).toBe("Partial reconnect metadata");
  });

  it.each([
    { key: "agent:main:current", archived: false },
    { key: "agent:main:current", archived: true },
    { key: "agent:main:fork", parentSessionKey: "agent:main:parent" },
    { key: "agent:main:subagent:child" },
  ])("renders available header actions for $key (archived: $archived)", async (fields) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    state.settings = loadSettings();
    const session = {
      ...fields,
      sessionId: "current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.body.appendChild(document.createElement("div"));
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    const menu = container.querySelector("openclaw-chat-header-session-menu");
    expect(menu).not.toBeNull();
    await menu?.updateComplete;
    if (fields.archived === undefined) {
      expect(menu?.querySelector('[value="toggle-pin"]')).toBeNull();
    } else {
      const action = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="toggle-archived"]',
      );
      expect(action).not.toBeNull();
      expect(action?.disabled).toBe(false);
      expect(action?.textContent).toContain(
        t(fields.archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession"),
      );
    }
  });

  it("forks through the shared session organizer flow and selects the new session", async () => {
    const create = vi.fn(async () => "agent:main:forked");
    const sessions = createSessionCapabilityFixture({
      create,
      state: { error: null },
    });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    Object.assign(pane.context.gateway.snapshot.hello?.features ?? {}, {
      methods: ["sessions.patch", "sessions.create"],
    });
    const onPaneSessionChange = vi.fn();
    pane.onPaneSessionChange = onPaneSessionChange;
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      hasActiveRun: true,
    } satisfies GatewaySessionRow;

    await pane.handleHeaderSessionAction({ kind: "fork" }, session);

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: session.key,
      fork: true,
      forkFrom: "last-completed",
      agentId: "main",
    });
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    { action: { kind: "toggle-pin" }, patch: { pinned: true }, current: "removed" },
    { action: { kind: "toggle-pin" }, patch: { pinned: true }, current: "replacement" },
    { action: { kind: "toggle-unread" }, patch: { unread: true }, current: "replacement" },
    { action: { kind: "set-icon", icon: "🦞" }, patch: { icon: "🦞" }, current: "replacement" },
    {
      action: { kind: "set-color", color: "red" },
      patch: { color: "red" },
      current: "replacement",
    },
    {
      action: { kind: "reset-appearance" },
      patch: { icon: null, color: null },
      current: "replacement",
    },
    {
      action: { kind: "move-to-group", category: "Projects" },
      patch: { category: "Projects" },
      current: "replacement",
    },
    {
      action: { kind: "move-to-group", category: "Projects" },
      patch: { category: "Projects" },
      current: "refreshed",
    },
  ] as const)(
    "keeps header $action.kind scoped to its captured row ($current)",
    async ({ action, patch: expectedPatch, current }) => {
      const patch = vi.fn(async () => ({}));
      const original: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: current === "removed" ? undefined : "original-session",
        kind: "direct",
        updatedAt: 0,
        ...(current === "refreshed" ? { category: "Projects" } : {}),
      };
      const result = sessionsResult([original], 1);
      const sessions = createSessionCapabilityFixture({
        patch,
        state: { error: null, groups: ["Projects", "Other"], result },
      });
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions,
      });
      result.sessions =
        current === "removed"
          ? []
          : [
              {
                ...original,
                ...(current === "refreshed"
                  ? { category: "Other" }
                  : { sessionId: "replacement-session" }),
              },
            ];
      await pane.handleHeaderSessionAction(action, original);
      if (current === "removed") {
        expect(patch).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith({ message: t("common.refresh") });
      } else {
        expect(patch).toHaveBeenCalledWith(original.key, expectedPatch, {
          agentId: "main",
          expectedSessionId: original.sessionId,
        });
      }
    },
  );

  it.each([
    {
      name: "trimmed label",
      key: "agent:main:current",
      sessionId: "rename-current",
      value: "  Renamed session  ",
      label: "Renamed session",
      agentId: "main",
    },
    {
      name: "canonical global",
      key: "global",
      sessionId: "research-global",
      value: "Research thread",
      label: "Research thread",
      agentId: "research",
    },
    {
      name: "unchanged generated title",
      key: "agent:main:dashboard:generated",
      displayName: "Generated title",
      value: "Generated title",
      agentId: "main",
    },
  ])(
    "renames only an edited captured session: $name",
    ({ key, sessionId, displayName, value, label, agentId }) => {
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions: createSessionCapabilityFixture({ patch }),
      });
      state.sessionKey = key;
      state.assistantAgentId = agentId;
      const session: GatewaySessionRow = {
        key,
        sessionId,
        displayName,
        kind: key === "global" ? "global" : "direct",
        updatedAt: 0,
      };
      pane.beginHeaderRename(session);
      if (displayName) {
        expect(pane.headerRenameValue).toBe(displayName);
      }
      pane.headerRenameValue = value;
      pane.commitHeaderRename();
      if (!label) {
        pane.beginHeaderRename(session);
        pane.cancelHeaderRename();
        expect(patch).not.toHaveBeenCalled();
        return;
      }
      expect(patch).toHaveBeenCalledWith(key, { label }, { agentId, expectedSessionId: sessionId });
      if (key !== "global") {
        pane.beginHeaderRename({ ...session, label });
        pane.headerRenameValue = "   ";
        pane.commitHeaderRename();
        expect(patch).toHaveBeenLastCalledWith(
          key,
          { label: null },
          { agentId, expectedSessionId: sessionId },
        );
      }
    },
  );
});

it("reads the actual Gateway promotion projection through the header adapter", async () => {
  const { pane, state, session } = promotionFixture();
  const container = document.body.appendChild(document.createElement("div"));
  render(
    pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(state),
      session,
      false,
      undefined,
      false,
      null,
    ),
    container,
  );
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  expect(menu.session.capabilityStatus).toEqual(session.promotion);
  expect(menu.session.capabilityStatus?.canCancel).toBe(false);
  container.remove();
});

it("keeps an acknowledged mutation uncertain when refresh yields only the old cached projection", async () => {
  const { pane, session, request, refresh } = promotionFixture();
  refresh.mockImplementation(async () => undefined);
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not submit when the authoritative metadata carries a disabled reason", async () => {
  const { pane, session, request } = promotionFixture();
  Object.assign(session.promotion, { disabledReasons: ["Permission revoked"] });
  await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
  expect(request).not.toHaveBeenCalled();
});

it("shows a disconnected disabled reason rather than offering a stale authorized action", async () => {
  const { pane, state, session } = promotionFixture();
  Object.assign(pane.context.gateway.snapshot, { phase: "stopped", client: null });
  const container = document.body.appendChild(document.createElement("div"));
  render(
    pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(state),
      session,
      false,
      undefined,
      false,
      null,
    ),
    container,
  );
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  expect(
    menu.querySelector('wa-dropdown-item[value="promote-session"]')?.hasAttribute("disabled"),
  ).toBe(true);
  expect(menu.textContent).toContain(t("sessionsView.actionRequiresConnection"));
  container.remove();
});

describe("promotion cancellation follows the real Gateway projection", () => {
  it("cancels an authorized pending promotion with the projected original request id", async () => {
    const { pane, session, request } = promotionFixture(undefined, "authorized-pending");
    await pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, session);
    expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.promote", {
      key: session.key,
      expectedSessionId: session.sessionId,
      expectedLifecycleRevision: "rev-one",
      requestId: PENDING_REQUEST_ID,
      action: "cancel",
    });
  });

  it.each<[string, PromotionFixtureKind]>([
    ["an unauthorized pending viewer", "unauthorized-pending"],
    ["a restricted viewer", "restricted-viewer"],
    ["a stale or invalid identity", "stale-identity"],
  ])("neither requests nor cancels for %s", async (_name, kind) => {
    const { pane, session, request } = promotionFixture(undefined, kind);
    await pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, session);
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("never infers cancel authority from pending state, a permissive canPromote or a fresh id", async () => {
    // The previous masking fixture: pending with canPromote=true and no reasons, canCancel=false.
    const masked = promotionFixture(undefined, "unauthorized-pending");
    Object.assign(masked.session.promotion, { canPromote: true, disabledReasons: [] });
    await masked.pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, masked.session);
    expect(masked.request).not.toHaveBeenCalled();
    // canCancel without the original id fails closed rather than minting a fresh UUID.
    const noId = promotionFixture(undefined, "authorized-pending");
    delete noId.session.promotion.pendingRequestId;
    await noId.pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, noId.session);
    expect(noId.request).not.toHaveBeenCalled();
  });

  it("does not send a cancel when the pending identity changes during confirmation", async () => {
    const changedId = promotionFixture(undefined, "authorized-pending");
    vi.mocked(showConfirmDialog).mockImplementationOnce(async () => {
      changedId.session.promotion = {
        ...changedId.session.promotion,
        pendingRequestId: "req-replacement",
      };
      return true;
    });
    await changedId.pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, changedId.session);
    expect(changedId.request).not.toHaveBeenCalled();
    const lostAuthority = promotionFixture(undefined, "authorized-pending");
    vi.mocked(showConfirmDialog).mockImplementationOnce(async () => {
      lostAuthority.session.promotion = promotionProjection("unauthorized-pending");
      return true;
    });
    await lostAuthority.pane.handleHeaderSessionAction(
      { kind: "cancel-promotion" },
      lostAuthority.session,
    );
    expect(lostAuthority.request).not.toHaveBeenCalled();
  });

  it("requests with a fresh id, then cancels with the projected id after a reload", async () => {
    const request = vi.fn(async () => ({}));
    const first = promotionFixture(request);
    first.refresh.mockImplementation(async () => {
      first.result.sessions[0]!.promotion = promotionProjection("authorized-pending");
    });
    await first.pane.handleHeaderSessionAction({ kind: "promote-session" }, first.session);
    const requested = (
      request.mock.calls as unknown as Array<[string, { requestId: string; action: string }]>
    )[0]![1];
    expect(requested.action).toBe("request");
    expect(requested.requestId).not.toBe(PENDING_REQUEST_ID);
    // Reload: a brand-new pane reads the refreshed pending projection from the row.
    const reloaded = promotionFixture(request, "authorized-pending");
    await reloaded.pane.handleHeaderSessionAction({ kind: "cancel-promotion" }, reloaded.session);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.promote",
      expect.objectContaining({ action: "cancel", requestId: PENDING_REQUEST_ID }),
    );
  });
});

describe("promotion operation state is bound to connection, key and session identity", () => {
  const failing = () =>
    vi.fn(async () => {
      throw new Error("transport lost");
    });

  it("does not let a replacement session with the same key inherit an uncertain outcome", async () => {
    const request = failing();
    const { pane, session, result } = promotionFixture(request);
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(request).toHaveBeenCalledTimes(1);
    const replacement = {
      ...session,
      sessionId: "session-replacement",
      promotion: { ...promotionProjection("authorized-none"), lifecycleRevision: "rev-new" },
    } satisfies GatewaySessionRow;
    result.sessions = [replacement];
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, replacement);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.promote",
      expect.objectContaining({ expectedSessionId: "session-replacement" }),
    );
    // The original target stays uncertain and is never retried automatically.
    result.sessions = [session];
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not let a different gateway connection inherit an uncertain outcome", async () => {
    const request = failing();
    const { pane, session } = promotionFixture(request);
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(request).toHaveBeenCalledTimes(1);
    const original = pane.context.gateway.connection.gatewayUrl;
    pane.context.gateway.connection.gatewayUrl = "ws://other-gateway.test";
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(request).toHaveBeenCalledTimes(2);
    pane.context.gateway.connection.gatewayUrl = original;
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("hands the header menu fresh state for a replacement session with the same key", async () => {
    const request = failing();
    const { pane, state, session, result } = promotionFixture(request);
    await pane.handleHeaderSessionAction({ kind: "promote-session" }, session);
    const container = document.body.appendChild(document.createElement("div"));
    const draw = (row: GatewaySessionRow) =>
      render(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          row,
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
    draw(session);
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    expect(menu.session.promotionUncertain).toBe(true);
    const replacement = { ...session, sessionId: "session-replacement" };
    result.sessions = [replacement];
    draw(replacement);
    await menu.updateComplete;
    expect(menu.session.promotionUncertain).toBeFalsy();
    expect(menu.session.promotionMessage).toBeUndefined();
    container.remove();
  });
});
