/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, ToolsEffectiveResult } from "../../../api/types.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import {
  recordRunAuthorityClass,
  resetRunAuthorityTestState,
} from "../../../lib/chat/turn-authority.ts";
import { promotionProjection } from "../../../lib/sessions/session-promotion.test-support.ts";
import { createTurnAuthorityHost } from "../chat-pane-turn-authority.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import type { TurnAuthorityHost } from "./chat-turn-authority-marker.ts";

const LABEL = "Ran with delegated limits, not your normal permissions";

let container: HTMLDivElement | undefined;
afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = undefined;
  }
  resetRunAuthorityTestState();
});

function userGroup(messages: Record<string, unknown>[], role = "user"): MessageGroup {
  return {
    kind: "group",
    key: "turns",
    role,
    timestamp: 0,
    visibleContent: "text",
    isStreaming: false,
    messages: messages.map((message, index) => ({
      key: `turn-${index}`,
      hasVisibleContent: true,
      message: { role, timestamp: index + 1, ...message },
    })),
  };
}

function renderGroup(group: MessageGroup, turnAuthority?: TurnAuthorityHost) {
  container = document.createElement("div");
  document.body.append(container);
  render(
    renderMessageGroup(group, {
      showReasoning: false,
      showToolCalls: false,
      avatarPlacement: "none",
      agentId: "main",
      turnAuthority,
    }),
    container,
  );
  return container;
}

function bubbleMarkers(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(".chat-bubble")].map((bubble) =>
    Boolean(bubble.querySelector("openclaw-chat-turn-authority-marker")),
  );
}

function popoverLines(root: HTMLElement) {
  return [...root.querySelectorAll("wa-popover p")].map((line) => line.textContent?.trim());
}

async function settle(root: HTMLElement) {
  for (const element of root.querySelectorAll("openclaw-chat-turn-authority-marker")) {
    await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
  }
}

describe("delegated-turn marker", () => {
  it("marks only user turns stamped delegated", async () => {
    const root = renderGroup(
      userGroup([
        { content: "delegated turn", __openclaw: { authorityClass: "delegated" } },
        { content: "ordinary turn", __openclaw: { authorityClass: "ordinary" } },
        { content: "older turn" },
      ]),
    );
    await settle(root);
    expect(bubbleMarkers(root)).toEqual([true, false, false]);
    const trigger = root.querySelector<HTMLButtonElement>(".chat-turn-authority__trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe(LABEL);
    expect(trigger.title).toBe(LABEL);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    // A real button: reachable by keyboard and skipped by the touch meta toggle.
    expect(trigger.type).toBe("button");
    expect(trigger.querySelector("[aria-hidden='true']")?.textContent).toBe("!");
    // The bubble keeps its own text; the glyph is not part of the copied message.
    expect(root.querySelector(".chat-bubble")?.getAttribute("data-message-text")).toBe(
      "delegated turn",
    );
  });

  it("never marks assistant messages, even with a stamp", async () => {
    const root = renderGroup(
      userGroup([{ content: "reply", __openclaw: { authorityClass: "delegated" } }], "assistant"),
    );
    await settle(root);
    expect(root.querySelector("openclaw-chat-turn-authority-marker")).toBeNull();
  });

  it("marks the local copy of a turn once its run's live chat event reports delegated", async () => {
    const group = userGroup([{ content: "go on", __openclaw: { idempotencyKey: "run-7:user" } }]);
    let root = renderGroup(group);
    expect(bubbleMarkers(root)).toEqual([false]);
    render(null, root);
    root.remove();
    recordRunAuthorityClass("run-7", "delegated");
    root = renderGroup(group);
    await settle(root);
    expect(bubbleMarkers(root)).toEqual([true]);
  });

  it("mounts its popover on first activation: the turn, the session now, and a way to Permissions", async () => {
    const host: TurnAuthorityHost = {
      readPermissionsHeadline: vi.fn(async () => "Delegated · 1 extra limit"),
      openPermissions: vi.fn(() => true),
    };
    const root = renderGroup(
      userGroup([{ content: "delegated turn", __openclaw: { authorityClass: "delegated" } }]),
      host,
    );
    await settle(root);
    expect(root.querySelector("wa-popover")).toBeNull();
    const trigger = root.querySelector<HTMLButtonElement>(".chat-turn-authority__trigger")!;
    trigger.click();
    await settle(root);
    const popover = root.querySelector("wa-popover")!;
    expect(popover.getAttribute("for")).toBe(trigger.id);
    expect(popover.getAttribute("aria-label")).toBe(LABEL);
    expect(popoverLines(root)).toEqual([
      "This message ran with delegated limits.",
      "Now: Checking permissions…",
    ]);
    popover.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() =>
      expect(popoverLines(root)).toEqual([
        "This message ran with delegated limits.",
        "Now: Delegated · 1 extra limit",
      ]),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Inform only: the popover offers the sheet, not a promotion of its own.
    const buttons = [...popover.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(buttons).toEqual(["Open Session settings"]);
    popover.querySelector<HTMLButtonElement>(".chat-turn-authority__link")!.click();
    expect(host.openPermissions).toHaveBeenCalledWith(trigger);
  });

  it("says the permissions are not checked when the headline cannot be read", async () => {
    const host: TurnAuthorityHost = {
      readPermissionsHeadline: () => Promise.reject(new Error("offline")),
      openPermissions: () => false,
    };
    const root = renderGroup(
      userGroup([{ content: "delegated turn", __openclaw: { authorityClass: "delegated" } }]),
      host,
    );
    await settle(root);
    root.querySelector<HTMLButtonElement>(".chat-turn-authority__trigger")!.click();
    await settle(root);
    root.querySelector("wa-popover")!.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() =>
      expect(root.querySelector(".chat-turn-authority__headline")?.textContent?.trim()).toBe(
        "Now: Permissions not checked yet",
      ),
    );
  });

  it("keeps the turn's delegated line when the session has since been promoted", async () => {
    const host: TurnAuthorityHost = {
      readPermissionsHeadline: async () => "Full permissions",
      openPermissions: () => true,
    };
    const root = renderGroup(
      userGroup([{ content: "older turn", __openclaw: { authorityClass: "delegated" } }]),
      host,
    );
    await settle(root);
    root.querySelector<HTMLButtonElement>(".chat-turn-authority__trigger")!.click();
    await settle(root);
    root.querySelector("wa-popover")!.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() =>
      expect(popoverLines(root)).toEqual([
        "This message ran with delegated limits.",
        "Now: Full permissions",
      ]),
    );
  });

  it("shows only the turn's line where no session can be checked", async () => {
    const root = renderGroup(
      userGroup([{ content: "imported turn", __openclaw: { authorityClass: "delegated" } }]),
    );
    await settle(root);
    root.querySelector<HTMLButtonElement>(".chat-turn-authority__trigger")!.click();
    await settle(root);
    const popover = root.querySelector("wa-popover")!;
    expect(popoverLines(root)).toEqual(["This message ran with delegated limits."]);
    expect(popover.querySelector("button")).toBeNull();
  });
});

describe("createTurnAuthorityHost", () => {
  const row = {
    key: "agent:main:subagent:child",
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    promotion: { ...promotionProjection("authorized-none"), classScope: "all-turns" },
  } as GatewaySessionRow;

  function tools(restrictions: ToolsEffectiveResult["restrictions"]): ToolsEffectiveResult {
    return { agentId: "main", profile: "coding", groups: [], restrictions };
  }

  it("words the headline as the sheet does, from one tools.effective read", async () => {
    const request = vi.fn(async () =>
      tools({
        evaluatedClass: "delegated",
        limitedTools: [{ id: "browser", origins: ["inherited-limit"] }],
        sessionsSend: "denied",
        evaluatedAt: 1,
      }),
    );
    const host = createTurnAuthorityHost({
      readRow: () => row,
      readClient: () => ({ request }) as never,
      openPermissions: () => true,
    });
    await expect(host.readPermissionsHeadline()).resolves.toBe(
      "Delegated · 1 extra limit · can't message other sessions",
    );
    expect(request).toHaveBeenCalledWith("tools.effective", {
      sessionKey: row.key,
      agentId: "main",
    });
  });

  it("reads full permissions for a session limited nowhere", async () => {
    const host = createTurnAuthorityHost({
      readRow: () => row,
      readClient: () =>
        ({
          request: async () =>
            tools({
              evaluatedClass: "ordinary",
              limitedTools: [],
              sessionsSend: "allowed",
              evaluatedAt: 1,
            }),
        }) as never,
      openPermissions: () => true,
    });
    await expect(host.readPermissionsHeadline()).resolves.toBe("Full permissions");
  });

  it("claims nothing without a connection or a row", async () => {
    const request = vi.fn();
    for (const host of [
      createTurnAuthorityHost({
        readRow: () => row,
        readClient: () => null,
        openPermissions: () => true,
      }),
      createTurnAuthorityHost({
        readRow: () => undefined,
        readClient: () => ({ request }) as never,
        openPermissions: () => true,
      }),
    ]) {
      await expect(host.readPermissionsHeadline()).resolves.toBe("Permissions not checked yet");
    }
    expect(request).not.toHaveBeenCalled();
  });
});
