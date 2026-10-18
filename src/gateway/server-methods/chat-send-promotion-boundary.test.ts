import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  order: [] as string[],
  normalize: vi.fn(),
  prepareSession: vi.fn(),
}));
vi.mock("./sessions-promotion-activation.js", () => ({
  activateSessionPromotionBeforeAdmission: mocks.activate,
}));
vi.mock("./chat-send-request.js", () => ({ normalizeChatSendRequest: mocks.normalize }));
vi.mock("./chat-send-session.js", () => ({
  prepareChatSendSession: mocks.prepareSession,
  qualifyChatSendSession: vi.fn(),
  prepareChatSendNativeRuntimeRestriction: vi.fn(),
}));
vi.mock("./chat-send-pre-admission.js", () => ({
  runChatSendPreAdmission: vi.fn(),
  respondChatSendAdmissionError: vi.fn(),
}));
vi.mock("./chat-send-admission.js", () => ({ admitChatSend: vi.fn() }));

import {
  activatePendingPromotionBeforeChatSend,
  isDirectHumanChatTurn,
  isFreshHumanChatAdmission,
} from "./chat-send-promotion-boundary.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";

function request(overrides: Partial<NormalizedChatSendRequest> = {}): NormalizedChatSendRequest {
  return {
    turnKind: "main",
    stopCommand: false,
    reconnectResumeRequested: false,
    clientInfo: { id: "openclaw-control-ui", mode: "webchat", version: "1", platform: "web" },
    p: { sessionKey: "agent:main:dashboard:target", idempotencyKey: "run-1" },
    ...overrides,
  } as unknown as NormalizedChatSendRequest;
}
function context(extra: Record<string, unknown> = {}) {
  return {
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
    ...extra,
  } as never;
}
const client = {} as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
});

describe("direct human turn / fresh admission predicate", () => {
  it("accepts a new main Control UI turn", () => {
    expect(isDirectHumanChatTurn(request())).toBe(true);
    expect(isFreshHumanChatAdmission(request(), { context: context() })).toBe(true);
  });
  it.each([
    ["btw turn", { turnKind: "btw" }],
    ["stop command", { stopCommand: true }],
    ["system provenance", { systemInputProvenance: { kind: "inter_session" } }],
    ["system receipt", { systemProvenanceReceipt: "x" }],
    ["goal operation", { goalOperation: { action: "resume" } }],
    ["provider review continuation", { providerReviewAcknowledgment: {} }],
    ["reconnect resume", { reconnectResumeRequested: true }],
    ["non-UI client", { clientInfo: { id: "cli", mode: "cli", version: "1", platform: "node" } }],
  ])("is not a boundary for a %s", (_name, overrides) => {
    expect(isDirectHumanChatTurn(request(overrides as never))).toBe(false);
  });
  it("is not a boundary for trusted system input or a replayed/queued idempotency key", () => {
    expect(
      isFreshHumanChatAdmission(request(), { context: context(), trustedSystemInput: true }),
    ).toBe(false);
    for (const key of ["chat:run-1"]) {
      const ctx = context();
      (ctx as { dedupe: Map<string, unknown> }).dedupe.set(key, {});
      expect(isFreshHumanChatAdmission(request(), { context: ctx })).toBe(false);
    }
    const aborts = context();
    (aborts as { chatAbortControllers: Map<string, unknown> }).chatAbortControllers.set(
      "run-1",
      {},
    );
    expect(isFreshHumanChatAdmission(request(), { context: aborts })).toBe(false);
  });
});

describe("activatePendingPromotionBeforeChatSend", () => {
  it("activates only for a fresh human admission", async () => {
    await activatePendingPromotionBeforeChatSend({
      request: request({ turnKind: "btw" }),
      options: { client, context: context() },
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    await activatePendingPromotionBeforeChatSend({
      request: request(),
      options: { client, context: context() },
    });
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:dashboard:target" }),
    );
  });
  it("never fails the chat when activation is deferred", async () => {
    mocks.activate.mockRejectedValue(new Error("conflict"));
    const ctx = context();
    await expect(
      activatePendingPromotionBeforeChatSend({
        request: request(),
        options: { client, context: ctx },
      }),
    ).resolves.toBeUndefined();
    expect(
      (ctx as unknown as { logGateway: { warn: ReturnType<typeof vi.fn> } }).logGateway.warn,
    ).toHaveBeenCalled();
  });
  it("rethrows when the request itself was aborted", async () => {
    mocks.activate.mockRejectedValue(new Error("aborted"));
    const signal = AbortSignal.abort();
    await expect(
      activatePendingPromotionBeforeChatSend({
        request: request(),
        options: { client, context: context(), signal },
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("chat.send setup ordering", () => {
  it("settles the intent BEFORE the session lifecycle identity is loaded", async () => {
    mocks.normalize.mockReturnValue({ ok: true, value: request() });
    mocks.activate.mockImplementation(async () => {
      mocks.order.push("activate");
    });
    mocks.prepareSession.mockImplementation(() => {
      mocks.order.push("load-session");
      return { ok: false, error: "stop here" };
    });
    const respond = vi.fn();
    await prepareAndAdmitChatSend({
      params: {},
      respond,
      context: context(),
      client,
    } as never);
    expect(mocks.order).toEqual(["activate", "load-session"]);
  });
  it("does not run the boundary for trusted internal input", async () => {
    mocks.normalize.mockReturnValue({ ok: true, value: request() });
    mocks.prepareSession.mockReturnValue({ ok: false, error: "stop here" });
    await prepareAndAdmitChatSend(
      { params: {}, respond: vi.fn(), context: context(), client } as never,
      undefined,
      { trustedSystemInput: true },
    );
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
