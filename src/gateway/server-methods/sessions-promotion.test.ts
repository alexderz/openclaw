import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  capture: vi.fn(),
  request: vi.fn(),
  current: vi.fn(),
  release: vi.fn(),
  requestCurrent: vi.fn(),
  access: vi.fn(),
  accessCurrent: vi.fn(),
  accessRelease: vi.fn(),
  notify: vi.fn(),
  paired: vi.fn(),
  database: vi.fn(),
}));
vi.mock("../../infra/device-pairing.js", () => ({ getPairedDevice: mocks.paired }));
vi.mock("../../state/openclaw-state-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db.paths.js")>()),
  existingPathOrUndefined: mocks.database,
}));
vi.mock("../../sessions/session-work-settlement.js", () => ({
  notifySessionWorkSettled: mocks.notify,
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../github-publication-requester.js", () => ({
  captureGitHubPublicationRequester: mocks.capture,
}));
vi.mock("../session-access-authority.js", () => ({
  prepareGatewaySessionAccessAuthority: mocks.access,
}));
vi.mock("../../sessions/session-promotion.js", () => ({
  requestSessionPromotion: mocks.request,
}));
import {
  SessionPromotionConflictError,
  SessionPromotionUnsupportedError,
} from "../../sessions/session-promotion-state.js";
import { CORE_GATEWAY_METHOD_SPECS } from "../methods/core-descriptors.js";
import {
  createCoreGatewayMethodDescriptors,
  resolveCoreOperatorGatewayMethodScope,
} from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { sessionMutationTargetFields } from "../session-method-policy.js";
import { sessionPromotionHandlers } from "./sessions-promotion.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function fixture() {
  const client = {
    connId: "human",
    authenticatedUserId: "user",
    authenticatedUserProfile: { profileId: "alice" },
    connect: { role: "operator", scopes: ["operator.sessions.write"] },
    internal: {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      operatorRoleActor: { kind: "operator", profileId: "alice" },
    },
  };
  const options = {
    req: { type: "req", id: "request", method: "sessions.promote" },
    client,
    params: {
      key: "agent:main:dashboard:target",
      expectedSessionId: "session",
      expectedLifecycleRevision: "revision",
      requestId: "request",
    },
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      getClientConnIds: (filter: (value: unknown) => boolean) =>
        new Set(filter(client) ? [client.connId] : []),
    },
    respond: vi.fn(),
    isWebchatConnect: () => false,
    assertInvocationCurrent: mocks.requestCurrent,
    sessionMutationAuthorization: { assertCurrent: mocks.requestCurrent },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, client, respond: options.respond as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.mockImplementation((pathname: string) => pathname);
  mocks.access.mockResolvedValue({
    assertCurrent: mocks.accessCurrent,
    release: mocks.accessRelease,
  });
  mocks.caller.mockReturnValue(undefined);
  mocks.capture.mockResolvedValue({
    requester: {
      snapshot: {
        version: 1,
        actor: { kind: "operator", profileId: "alice" },
        scopes: ["operator.sessions.write"],
      },
      assertCurrent: mocks.current,
    },
    release: mocks.release,
  });
  mocks.request.mockImplementation(async (params) => {
    params.assertCurrent();
    return {
      version: 1,
      state: "pending",
      requestId: "request",
      acceptedAt: 1,
      boundary: "settlement-or-fresh-human-input",
      target: {
        agentId: "main",
        key: "agent:main:dashboard:target",
        sessionId: "session",
        fromLifecycleRevision: "revision",
      },
      requester: {
        version: 1,
        actor: { kind: "operator", profileId: "alice" },
        scopes: ["operator.sessions.write", "operator.admin"],
        grant: { pluginId: "private", grantId: "00000000-0000-4000-8000-000000000000" },
      },
    };
  });
});

async function invoke(options: GatewayRequestHandlerOptions) {
  await sessionPromotionHandlers["sessions.promote"]!(options);
}

describe("sessions.promote", () => {
  it("registers as a session-write core method with a required target", () => {
    expect(CORE_GATEWAY_METHOD_SPECS.find(([name]) => name === "sessions.promote")).toEqual([
      "sessions.promote",
      "sessions-promotion",
      "operator.sessions.write",
      "2026.10",
    ]);
    expect(sessionMutationTargetFields("sessions.promote")).toEqual(["key"]);
    expect(resolveCoreOperatorGatewayMethodScope("sessions.promote")).toBe(
      "operator.sessions.write",
    );
  });
  it.each([SessionPromotionConflictError, SessionPromotionUnsupportedError])(
    "maps expected helper rejections without leaking internals",
    async (Failure) => {
      const { options, respond } = fixture();
      mocks.request.mockRejectedValueOnce(new Failure());
      await invoke(options);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(mocks.accessRelease).toHaveBeenCalledOnce();
    },
  );
  it("prepares a server requester and revalidates before the helper mutation", async () => {
    const { options, respond } = fixture();
    await invoke(options);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        client: options.client,
        hasCurrentClientAuthority: expect.any(Function),
      }),
      { sessionKey: options.params.key, agentId: "main" },
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session",
        expectedLifecycleRevision: "revision",
        requestId: "request",
        action: "request",
        requester: expect.objectContaining({ actor: { kind: "operator", profileId: "alice" } }),
      }),
    );
    expect(mocks.current).toHaveBeenCalled();
    expect(mocks.accessCurrent).toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith(
      expect.objectContaining({ policy: { mode: "write" }, ownSessionOnly: true }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ state: "pending" }),
      undefined,
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(["request", "cancel"])(
    "passes strict %s intent to the idempotent helper",
    async (action) => {
      const { options } = fixture();
      options.params.action = action;
      await invoke(options);
      expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ action }));
    },
  );
  it("binds a request to the device's pairing incarnation and refuses when pairing cannot be read", async () => {
    const withDevice = (id?: string) => {
      const f = fixture();
      (f.client.connect as { device?: { id: string } }).device = id ? { id } : undefined;
      return f;
    };
    mocks.paired.mockResolvedValue({ deviceId: "device-one", createdAtMs: 5, publicKey: "key" });
    await invoke(withDevice("device-one").options);
    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ device: { id: "device-one", generation: expect.any(String) } }),
    );
    // Readable and not paired: no device incarnation exists that could end the basis later.
    mocks.paired.mockResolvedValue(null);
    await invoke(withDevice("device-one").options);
    expect(mocks.request.mock.lastCall?.[0]).not.toHaveProperty("device");
    // A missing pairing database is unreadable state, not proof that the device is unpaired.
    mocks.request.mockClear();
    mocks.database.mockReturnValue(undefined);
    const missing = withDevice("device-one");
    await invoke(missing.options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(missing.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Session promotion is not available." }),
    );
    mocks.database.mockImplementation((pathname: string) => pathname);
    // A presented device whose pairing cannot be read is refused, never recorded as "none".
    mocks.request.mockClear();
    mocks.paired.mockRejectedValue(new Error("store down"));
    const unreadable = withDevice("device-one");
    await invoke(unreadable.options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(unreadable.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Session promotion is not available." }),
    );
    // Cancelling never depends on the device.
    const cancel = withDevice("device-one");
    cancel.options.params.action = "cancel";
    await invoke(cancel.options);
    expect(mocks.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: "cancel" }));
    expect(mocks.request.mock.lastCall?.[0]).not.toHaveProperty("device");
    await invoke(withDevice().options);
    expect(mocks.request.mock.lastCall?.[0]).not.toHaveProperty("device");
  });

  it("schedules one settlement attempt for the key after a pending request, never for cancel or failure", async () => {
    const pendingRequest = fixture();
    await invoke(pendingRequest.options);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(["agent:main:dashboard:target"]);
    mocks.notify.mockClear();
    const cancel = fixture();
    cancel.options.params.action = "cancel";
    mocks.request.mockImplementationOnce(async () => ({
      version: 1,
      state: "cancelled",
      requestId: "request",
      acceptedAt: 1,
      settledAt: 2,
      profileId: "alice",
      boundary: "settlement-or-fresh-human-input",
      target: {
        agentId: "main",
        key: "agent:main:dashboard:target",
        sessionId: "session",
        fromLifecycleRevision: "revision",
      },
    }));
    await invoke(cancel.options);
    mocks.request.mockRejectedValueOnce(new SessionPromotionConflictError());
    await invoke(fixture().options);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it.each(["requester", "grant", "actor", "scopes", "effectiveClass"])(
    "rejects caller supplied %s",
    async (field) => {
      const { options, respond } = fixture();
      options.params[field] = "forged";
      await invoke(options);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );
  it.each([
    "syntheticClient",
    "agentToolCaller",
    "agentRuntimeIdentity",
    "operatorRunAuthority",
    "cronRunContinuation",
    "approvalRuntime",
    "pluginRuntimeOwnerId",
    "nodeInvokeApprovalSessionKey",
  ])("denies autonomous %s even with a human profile and write scope", async (field) => {
    const { options, client, respond } = fixture();
    Object.assign(client.internal, { [field]: {} });
    await invoke(options);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it.each(["ownership", "agent access", "sandbox", "sharing"])(
    "denies revoked %s before mutation",
    async () => {
      const { options, respond } = fixture();
      mocks.accessCurrent.mockImplementation(() => {
        throw new Error("revoked");
      });
      await invoke(options);
      expect(mocks.request).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(mocks.accessRelease).toHaveBeenCalledOnce();
    },
  );
  it("revalidates the prepared role/grant basis in the helper commit guard", async () => {
    const { options, respond } = fixture();
    mocks.current
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("revoked");
      });
    await invoke(options);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("denies a profile without handshake-attested operator ingress", async () => {
    const { options, client, respond } = fixture();
    client.internal.authenticatedOperator = false;
    await invoke(options);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("denies changed role actor after asynchronous preparation", async () => {
    const { options, client, respond } = fixture();
    mocks.capture.mockImplementationOnce(async () => {
      client.internal.operatorRoleActor.profileId = "other";
      return { requester: { snapshot: {}, assertCurrent: mocks.current }, release: mocks.release };
    });
    await invoke(options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("denies ambient model-mediated caller", async () => {
    const { options, respond } = fixture();
    mocks.caller.mockReturnValue({ sessionKey: "agent:main:dashboard:target" });
    await invoke(options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("denies an unregistered connection", async () => {
    const { options, respond } = fixture();
    options.context.getClientConnIds = () => new Set();
    await invoke(options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("denies missing session write scope", async () => {
    const { options, client, respond } = fixture();
    client.connect.scopes = ["operator.read"];
    await invoke(options);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("rechecks connection and scope after requester preparation", async () => {
    const { options, client, respond } = fixture();
    mocks.capture.mockImplementationOnce(async () => {
      client.connect.scopes = [];
      return { requester: { snapshot: {}, assertCurrent: mocks.current }, release: mocks.release };
    });
    await invoke(options);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("builds the real gateway registry without a session-access descriptor that router and handler would both prepare", () => {
    const registry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({
        "sessions.promote": sessionPromotionHandlers["sessions.promote"]!,
      }),
    );
    expect(registry.getScope("sessions.promote")).toBe("operator.sessions.write");
    expect(registry.getSessionAccess?.("sessions.promote")).toBeUndefined();
    expect(registry.requiresAuthenticatedProfile("sessions.promote")).toBe(true);
  });
  it("prepares session access from the canonical sessionKey field the owner reads", async () => {
    const { options } = fixture();
    await invoke(options);
    expect(mocks.access).toHaveBeenCalledWith(
      expect.objectContaining({ requestParams: { sessionKey: options.params.key } }),
    );
  });
  it("denies an operator that lacks host-attested Control UI ingress", async () => {
    const { options, client, respond } = fixture();
    delete (client.internal as { authenticatedControlUi?: true }).authenticatedControlUi;
    await invoke(options);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
  it("returns only the typed sanitized result and never requester scopes or grant evidence", async () => {
    const { options, respond } = fixture();
    await invoke(options);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        key: "agent:main:dashboard:target",
        sessionId: "session",
        lifecycleRevision: "revision",
        requestId: "request",
        state: "pending",
        activation: "safe-boundary-before-fresh-human-run",
        effective: { class: "delegated" },
      },
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("private");
  });
});
