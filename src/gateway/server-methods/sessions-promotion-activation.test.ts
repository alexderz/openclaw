import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  capture: vi.fn(),
  restore: vi.fn(),
  access: vi.fn(),
  activate: vi.fn(),
  revoke: vi.fn(),
  probe: vi.fn(),
  target: vi.fn(),
  humanCurrent: vi.fn(),
  accessCurrent: vi.fn(),
  freshCurrent: vi.fn(),
  originalCurrent: vi.fn(),
  paired: vi.fn(),
  database: vi.fn(),
  releases: [] as string[],
}));
vi.mock("../../infra/device-pairing.js", () => ({ getPairedDevice: mocks.paired }));
vi.mock("../../state/openclaw-state-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db.paths.js")>()),
  existingPathOrUndefined: mocks.database,
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../github-publication-requester.js", () => ({
  captureGitHubPublicationRequester: mocks.capture,
  restoreGitHubPublicationRequester: mocks.restore,
}));
vi.mock("../session-access-authority.js", () => ({
  prepareGatewaySessionAccessAuthority: mocks.access,
}));
vi.mock("../../sessions/session-promotion.js", () => ({
  activatePendingSessionPromotion: mocks.activate,
  revokePendingSessionPromotion: mocks.revoke,
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryAccessTarget: mocks.target,
}));
vi.mock("./sessions-promotion-quiescence.js", () => ({
  probeSessionPromotionQuiescence: mocks.probe,
}));

import { UserProfileNotFoundError } from "../../state/user-profiles-schema.js";
import { GitHubPublicationRequesterUnavailableError } from "../github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import { GatewayOperatorAccessUnavailableError } from "../operator-access-policy.js";
import {
  activateSessionPromotionAfterSettlement,
  activateSessionPromotionBeforeAdmission,
} from "./sessions-promotion-activation.js";

const key = "agent:main:dashboard:target";
const pending = {
  version: 1,
  state: "pending",
  requestId: "request",
  acceptedAt: 1,
  boundary: "settlement-or-fresh-human-input",
  target: { agentId: "main", key, sessionId: "session", fromLifecycleRevision: "before" },
  requester: {
    version: 1,
    actor: { kind: "operator", profileId: "alice" },
    scopes: ["operator.sessions.write"],
    grant: null,
  },
};

function fixture(profileId = "alice") {
  const client = {
    connId: "human",
    authenticatedUserId: "user",
    authenticatedUserProfile: { profileId },
    connect: { role: "operator", scopes: ["operator.sessions.write"] },
    internal: {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      operatorRoleActor: { kind: "operator", profileId },
    },
  };
  const options = {
    client,
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      getClientConnIds: (filter: (value: unknown) => boolean) =>
        new Set(filter(client) ? [client.connId] : []),
    },
  } as unknown as Parameters<typeof activateSessionPromotionBeforeAdmission>[0]["options"];
  return { options, client };
}
const run = (options: Parameters<typeof activateSessionPromotionBeforeAdmission>[0]["options"]) =>
  activateSessionPromotionBeforeAdmission({ options, sessionKey: key });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.releases.length = 0;
  mocks.database.mockImplementation((pathname: string) => pathname);
  mocks.caller.mockReturnValue(undefined);
  mocks.target.mockReturnValue({
    entry: { sessionId: "session", lifecycleRevision: "before", sessionPromotion: pending },
    storePath: "/store",
    canonicalKey: key,
    storeKey: key,
    storeKeys: [],
  });
  mocks.access.mockResolvedValue({
    authority: {
      assertCurrent: mocks.accessCurrent,
      release: () => mocks.releases.push("access"),
    },
    assertPreparationCurrent: () => {},
  });
  mocks.capture.mockResolvedValue({
    requester: { snapshot: pending.requester, assertCurrent: mocks.freshCurrent },
    release: () => mocks.releases.push("fresh"),
  });
  mocks.restore.mockResolvedValue({
    snapshot: pending.requester,
    assertCurrent: mocks.originalCurrent,
    release: () => mocks.releases.push("original"),
  });
  mocks.probe.mockResolvedValue({ blockers: [], recheck: () => [] });
  mocks.activate.mockImplementation(async (params) => {
    params.assertCurrent();
    await params.probeBlockers({ add: vi.fn() });
    params.recheckBlockers?.(mocks.target().entry);
    return { activated: true, blockers: [], promotion: { state: "activated" } };
  });
});

describe("fresh-human admission activation boundary", () => {
  it.each([
    ["no promotion", undefined],
    ["an activated receipt", { ...pending, state: "activated", toLifecycleRevision: "after" }],
    ["a different incarnation", { ...pending, target: { ...pending.target, sessionId: "old" } }],
    ["a stale revision", { ...pending, target: { ...pending.target, fromLifecycleRevision: "x" } }],
  ])("does nothing for %s", async (_name, sessionPromotion) => {
    mocks.target.mockReturnValue({
      entry: { sessionId: "session", lifecycleRevision: "before", sessionPromotion },
      storePath: "/store",
      canonicalKey: key,
      storeKey: key,
      storeKeys: [],
    });
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it.each([
    "syntheticClient",
    "agentToolCaller",
    "agentRuntimeIdentity",
    "operatorRunAuthority",
    "cronRunContinuation",
    "approvalRuntime",
    "pluginRuntimeOwnerId",
  ])("never treats a %s caller as the recorded human", async (field) => {
    const { options, client } = fixture();
    Object.assign(client.internal, { [field]: {} });
    expect(await run(options)).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("requires host-attested Control UI ingress, not a wire client id or scopes", async () => {
    const { options, client } = fixture();
    delete (client.internal as { authenticatedControlUi?: true }).authenticatedControlUi;
    expect(await run(options)).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not let a different human consume the recorded human's intent", async () => {
    expect(await run(fixture("bob").options)).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("activates for the same live human under the original restored basis, inside the fence", async () => {
    expect(await run(fixture().options)).toBe("activated");
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session",
        expectedLifecycleRevision: "before",
        requestId: "request",
        basis: "original-basis",
      }),
    );
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/store",
        sessionKey: key,
        sessionId: "session",
        lifecycleIdentities: expect.arrayContaining([key, "session"]),
      }),
    );
    for (const guard of [mocks.accessCurrent, mocks.freshCurrent, mocks.originalCurrent]) {
      expect(guard).toHaveBeenCalled();
    }
    expect(mocks.releases.toSorted()).toEqual(["access", "fresh", "original"]);
  });

  it("pre-checks quiet outside the fence: a busy owner or durable obligation never enters it", async () => {
    mocks.probe.mockResolvedValueOnce({
      blockers: [{ code: "admission", owner: "session-work-admissions" }],
      recheck: () => [],
    });
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ quick: true }));
    mocks.target.mockReturnValue({
      entry: {
        sessionId: "session",
        lifecycleRevision: "before",
        sessionPromotion: pending,
        pendingFinalDelivery: { kind: "transport-only", createdAt: 1 },
      },
      storePath: "/store",
      canonicalKey: key,
      storeKey: key,
      storeKeys: [],
    });
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("probes owners outside the fence, then re-checks owners and the locked row synchronously at the commit", async () => {
    const watch = { add: vi.fn() };
    const recheck = vi.fn(() => [{ code: "queue", owner: "session-queues" }]);
    mocks.probe.mockResolvedValue({ blockers: [], recheck });
    let probed: readonly string[] = [];
    let blockers: readonly string[] = [];
    mocks.activate.mockImplementationOnce(async (params) => {
      probed = await params.probeBlockers(watch);
      expect(recheck).not.toHaveBeenCalled();
      blockers = params.recheckBlockers({
        sessionId: "session",
        lifecycleRevision: "before",
        restartRecoveryDeliveryRunId: "run-recovering",
      });
      return { activated: false, blockers, promotion: { state: "pending" } };
    });
    expect(await run(fixture().options)).toBe("unchanged");
    expect(probed).toEqual([]);
    expect(blockers).toEqual(expect.arrayContaining(["queue", "restart-recovery"]));
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ quick: false, watch }));
  });

  it("commit guard revalidates every authority and a mid-flight revocation aborts without activating", async () => {
    mocks.activate.mockImplementationOnce(async (params) => {
      mocks.originalCurrent.mockImplementation(() => {
        throw new Error("revoked");
      });
      params.assertCurrent();
      return { activated: true };
    });
    await expect(run(fixture().options)).rejects.toThrow("revoked");
    expect(mocks.releases.toSorted()).toEqual(["access", "fresh", "original"]);
  });

  it("stays pending (unchanged) while any owner reports work", async () => {
    mocks.activate.mockResolvedValue({ activated: false, blockers: ["run"], promotion: pending });
    expect(await run(fixture().options)).toBe("unchanged");
  });

  it("lets the same human rebind a grant that cannot be proved after restart, recording the rebinding", async () => {
    mocks.restore.mockRejectedValue(new GatewayOperatorAccessUnavailableError());
    expect(await run(fixture().options)).toBe("activated");
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({ basis: "fresh-human-rebound" }),
    );
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("will not rebind when the original scope ceiling no longer includes session write", async () => {
    mocks.restore.mockRejectedValue(new GatewayOperatorAccessUnavailableError());
    mocks.target.mockReturnValue({
      entry: {
        sessionId: "session",
        lifecycleRevision: "before",
        sessionPromotion: {
          ...pending,
          requester: { ...pending.requester, scopes: ["operator.read"] },
        },
      },
      storePath: "/store",
      canonicalKey: key,
      storeKey: key,
      storeKeys: [],
    });
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("records terminal revocation when the original basis provably ended and never revives it", async () => {
    mocks.restore.mockRejectedValue(new GitHubPublicationRequesterUnavailableError());
    expect(await run(fixture().options)).toBe("revoked");
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request",
        expectedSessionId: "session",
        expectedLifecycleRevision: "before",
        reason: "original-basis-ended",
      }),
    );
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.releases.toSorted()).toEqual(["access", "fresh"]);
  });

  describe("original device incarnation", () => {
    const paired = { deviceId: "device-one", createdAtMs: 5, publicKey: "key" };
    const generationOf = async (device: typeof paired) => {
      const owner = await import("../session-promotion-human.js");
      const generation = Reflect.get(owner, "promotionDeviceGeneration");
      expect(generation, "pairing incarnation owner must exist").toBeTypeOf("function");
      return (generation as (device: typeof paired) => string)(device);
    };
    const withDevice = (deviceGeneration: string) =>
      mocks.target.mockReturnValue({
        entry: {
          sessionId: "session",
          lifecycleRevision: "before",
          sessionPromotion: { ...pending, deviceId: "device-one", deviceGeneration },
        },
        storePath: "/store",
        canonicalKey: key,
        storeKey: key,
        storeKeys: [],
      });
    it("activates while the same pairing incarnation is still paired, even after re-approval", async () => {
      withDevice(await generationOf(paired));
      mocks.paired.mockResolvedValue({ ...paired, approvedAtMs: 9, scopes: ["operator.admin"] });
      expect(await run(fixture().options)).toBe("activated");
      expect(mocks.paired).toHaveBeenCalledWith("device-one");
      expect(mocks.revoke).not.toHaveBeenCalled();
    });
    it.each([
      ["paired again after an unpair", { ...paired, createdAtMs: 6 }],
      ["re-keyed by a new installation", { ...paired, publicKey: "other-key" }],
    ])("treats a device %s as a provable ending", async (_name, current) => {
      withDevice("5:original-incarnation");
      mocks.paired.mockResolvedValue(current);
      expect(await run(fixture().options)).toBe("revoked");
      expect(mocks.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "original-device-repaired", requestId: "request" }),
      );
      expect(mocks.activate).not.toHaveBeenCalled();
    });
    it("treats an unpaired original device as a provable ending, for either entrypoint", async () => {
      withDevice(await generationOf(paired));
      mocks.paired.mockResolvedValue(null);
      expect(await run(fixture().options)).toBe("revoked");
      expect(mocks.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "original-device-unpaired", requestId: "request" }),
      );
      expect(mocks.activate).not.toHaveBeenCalled();
      mocks.revoke.mockClear();
      expect(
        await activateSessionPromotionAfterSettlement({
          context: fixture().options.context,
          sessionKey: key,
        }),
      ).toBe("revoked");
      expect(mocks.revoke).toHaveBeenCalledTimes(1);
    });
    it("keeps the intent pending when the pairing store cannot be read", async () => {
      withDevice(await generationOf(paired));
      mocks.paired.mockRejectedValue(new Error("pairing store unavailable"));
      expect(await run(fixture().options)).toBe("unchanged");
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(mocks.activate).not.toHaveBeenCalled();
    });
    it("keeps the intent pending when the pairing database itself is missing", async () => {
      withDevice(await generationOf(paired));
      mocks.paired.mockResolvedValue(null);
      mocks.database.mockReturnValue(undefined);
      expect(await run(fixture().options)).toBe("unchanged");
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(mocks.activate).not.toHaveBeenCalled();
    });
    it.each([
      ["unpaired", null],
      ["re-keyed", { ...paired, publicKey: "other-key" }],
      ["unreadable", new Error("pairing store unavailable")],
    ])(
      "declines the commit when the device is %s during the authoritative probe",
      async (_name, during) => {
        withDevice(await generationOf(paired));
        mocks.paired.mockResolvedValueOnce(paired);
        if (during instanceof Error) {
          mocks.paired.mockRejectedValueOnce(during);
        } else {
          mocks.paired.mockResolvedValueOnce(during);
        }
        let probed: readonly string[] = [];
        mocks.activate.mockImplementationOnce(async (params) => {
          probed = await params.probeBlockers({ add: vi.fn() });
          return { activated: false, blockers: probed, promotion: { state: "pending" } };
        });
        expect(await run(fixture().options)).toBe("unchanged");
        expect(probed).toEqual(["original-device-unverified"]);
        expect(mocks.paired).toHaveBeenCalledTimes(2);
        // The next attempt's pre-check owns any terminal revocation; the commit only declines.
        expect(mocks.revoke).not.toHaveBeenCalled();
      },
    );
    it("does not consult the pairing store for an intent without a device", async () => {
      expect(await run(fixture().options)).toBe("activated");
      expect(mocks.paired).not.toHaveBeenCalled();
    });
  });

  it("never revokes on a transient identity read failure, only on a provable ending", async () => {
    mocks.restore.mockRejectedValue(
      new GitHubPublicationRequesterUnavailableError({
        cause: new Error("User profile catalog is not ready"),
      }),
    );
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.revoke).not.toHaveBeenCalled();
    mocks.restore.mockRejectedValue(
      new GitHubPublicationRequesterUnavailableError({ cause: new UserProfileNotFoundError("p") }),
    );
    expect(await run(fixture().options)).toBe("revoked");
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("keeps intent pending, neither active nor revoked, when profile storage is unavailable", async () => {
    mocks.restore.mockRejectedValue(new GitHubPublicationRecoveryPendingError("later"));
    expect(await run(fixture().options)).toBe("unchanged");
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("denies when the viewer's own-target access, ownership or sandbox facts are revoked", async () => {
    mocks.access.mockRejectedValue(new Error("denied"));
    await expect(run(fixture().options)).rejects.toThrow("denied");
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe("owner settlement entrypoint (no live human)", () => {
  const settle = () =>
    activateSessionPromotionAfterSettlement({
      context: (fixture().options as unknown as { context: never }).context,
      sessionKey: key,
    });
  it("consumes only the restored ORIGINAL basis: no fresh capture, no access preparation, no human synthesized", async () => {
    expect(await settle()).toBe("activated");
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({ basis: "original-basis", requestId: "request" }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.originalCurrent).toHaveBeenCalled();
    expect(mocks.releases).toEqual(["original"]);
  });
  it("never rebinds an unprovable grant without a fresh same-human admission", async () => {
    mocks.restore.mockRejectedValue(new GatewayOperatorAccessUnavailableError());
    expect(await settle()).toBe("unchanged");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("revokes terminally when the original basis provably ended, and stays quiet while blocked", async () => {
    mocks.restore.mockRejectedValue(new GitHubPublicationRequesterUnavailableError());
    expect(await settle()).toBe("revoked");
    mocks.restore.mockResolvedValue({
      snapshot: pending.requester,
      assertCurrent: mocks.originalCurrent,
      release: () => {},
    });
    mocks.revoke.mockClear();
    mocks.activate.mockResolvedValue({ activated: false, blockers: ["run"], promotion: pending });
    expect(await settle()).toBe("unchanged");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
