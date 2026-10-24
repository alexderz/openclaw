import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveRuntimeConfigCacheKey } from "../../config/config.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  peekToolsEffectiveRestrictions,
  testing as restrictionTesting,
} from "../tools-effective-restrictions.js";
import { toolsEffectiveInventoryMocks as inventoryMocks } from "./tools-effective.test-support.js";

const { toolsEffectiveHandlers, testing } = await import("./tools-effective.js");

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: vi.fn(),
}));

beforeEach(() => {
  testing.resetToolsEffectiveCacheForTest();
  restrictionTesting.resetToolsEffectiveRestrictionsForTest();
  vi.clearAllMocks();
});

it("invalidates fresh inventory when only the persisted session ceiling changes", async () => {
  const sessionKey = "agent:main:subagent:policy-refresh";
  const loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly> = {
    cfg: { agents: { entries: { main: {} } } },
    agentId: "main",
    storePath: "/tmp/tools-effective-policy-refresh/sessions.sqlite",
    store: {},
    canonicalKey: sessionKey,
    storeKeys: [sessionKey],
    legacyKey: undefined,
    entry: {
      sessionId: "unchanged-session",
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
    },
  };
  vi.mocked(loadGatewaySessionEntryReadOnly)
    .mockReturnValueOnce(loaded)
    .mockReturnValueOnce({
      ...loaded,
      entry: { ...expectDefined(loaded.entry, "session fixture"), inheritedToolDeny: ["exec"] },
    });
  const handler = expectDefined(
    toolsEffectiveHandlers["tools.effective"],
    "tools.effective handler",
  );
  const invoke = async () => {
    const respond = vi.fn();
    await handler({
      params: { sessionKey },
      respond: respond as never,
      context: { getRuntimeConfig: () => loaded.cfg } as never,
      client: null,
      req: { type: "req", id: "req-policy-refresh", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    return respond.mock.calls[0]?.[1];
  };

  const first = await invoke();
  inventoryMocks.resolveEffectiveToolInventory.mockResolvedValueOnce({
    agentId: "main",
    profile: "coding",
    groups: [],
  });
  const second = await invoke();

  expect(first).toMatchObject({ groups: [{ tools: [{ id: "exec" }] }] });
  expect(second).toMatchObject({ groups: [] });
  expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
  expect(
    inventoryMocks.resolveEffectiveToolInventory.mock.calls[1]?.[0].conversationCapabilityProfile,
  ).toMatchObject({ policy: { inheritedToolPolicy: { deny: ["exec"] } } });
});

it("publishes the restriction summary for session rows under the canonical key", async () => {
  const sessionKey = "agent:main:subagent:rows";
  const cfg = { agents: { entries: { main: {} } } };
  vi.mocked(loadGatewaySessionEntryReadOnly).mockReturnValue({
    cfg,
    agentId: "main",
    storePath: "/tmp/tools-effective-rows/sessions.sqlite",
    store: {},
    canonicalKey: sessionKey,
    storeKeys: [sessionKey],
    legacyKey: undefined,
    entry: { sessionId: "rows-session", lifecycleRevision: "rev-1", updatedAt: 1 },
  });
  const restrictions = {
    evaluatedClass: "delegated" as const,
    limitedTools: [{ id: "exec", origins: ["inherited-limit" as const] }],
    sessionsSend: "denied" as const,
    evaluatedAt: 7,
  };
  inventoryMocks.resolveEffectiveToolInventory.mockResolvedValueOnce({
    agentId: "main",
    profile: "coding",
    groups: [],
    restrictions,
  });
  const respond = vi.fn();
  await expectDefined(
    toolsEffectiveHandlers["tools.effective"],
    "tools.effective handler",
  )({
    params: { sessionKey },
    respond: respond as never,
    context: { getRuntimeConfig: () => cfg } as never,
    client: null,
    req: { type: "req", id: "req-rows", method: "tools.effective" },
    isWebchatConnect: () => false,
  });

  expect(respond.mock.calls[0]?.[1]).toMatchObject({ restrictions });
  expect(
    peekToolsEffectiveRestrictions({
      sessionKey,
      sessionId: "rows-session",
      lifecycleRevision: "rev-1",
      configKey: resolveRuntimeConfigCacheKey(cfg),
    }),
  ).toEqual(restrictions);
});
