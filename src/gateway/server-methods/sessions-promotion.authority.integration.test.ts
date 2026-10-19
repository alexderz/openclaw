import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { activateSessionPromotionAfterSettlement } from "./sessions-promotion-activation.js";
import { sessionPromotionHandlers } from "./sessions-promotion.js";
import type { GatewayClient } from "./types.js";

/** Handshake-attested internals as connect-session.ts sets them; the WS type declares a subset. */
function attest(client: GatewayWsClient, internal: NonNullable<GatewayClient["internal"]>) {
  (client as GatewayClient).internal = internal;
}

// Every owner here is real: profiles, operator access, router authorization, session access
// authority, sharing, the durable requester capture/restore and the SQLite session store.
afterEach(() => vi.restoreAllMocks());

const HOME = "agent:main:main";
const MOLTING = "agent:main:dashboard:molting";
const TARGET = "agent:main:dashboard:handoff";
const SUBAGENT = "agent:main:subagent:worker-1";
const INCOGNITO = "agent:main:dashboard:incognito-private";
const agentActor = { type: "agent" as const, id: "main" };

const rolesConfig: OpenClawConfig = {
  gateway: {
    roles: {
      default: "view",
      definitions: {
        view: {
          sessions: { others: "view" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
        write: {
          sessions: { others: "write" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
        admin: {
          sessions: { others: "write" },
          agents: "*",
          scopes: ["operator.admin"],
        },
      },
    },
  },
};

async function seed(key: string, entry: Partial<SessionEntry>) {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: key },
    { sessionId: key.replaceAll(":", "-"), updatedAt: 1, lifecycleRevision: "before", ...entry },
  );
}

// The parent's incarnation id is the one `seed` assigns: the lineage rule needs the exact parent.
const delegatedBy = (parent: string): Partial<SessionEntry> => ({
  createdActor: agentActor,
  parentSessionKey: parent,
  parentSessionId: parent.replaceAll(":", "-"),
  spawnedBy: parent,
  spawnDepth: 1,
});

/** The live tree: Home (no creator) → Molting (agent) → handoff (agent), plus a task child. */
async function seedLiveTree(root: { key: string; entry?: Partial<SessionEntry> } = { key: HOME }) {
  await seed(root.key, root.entry ?? {});
  await seed(MOLTING, delegatedBy(root.key));
  await seed(TARGET, { ...delegatedBy(MOLTING), label: "Promote to full session" });
  await seed(SUBAGENT, delegatedBy(MOLTING));
}

async function createWorld(cfg: OpenClawConfig) {
  setRuntimeConfigSnapshot(cfg);
  ensureGatewayOwnerProfile("Owner");
  const clients: GatewayWsClient[] = [];
  const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  const logGateway = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const context = bindSessionRowProjection(
    createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: createWorkerSessionPlacementStore(),
      getClientConnIds: (filter: (client: GatewayWsClient) => boolean) =>
        new Set(clients.filter(filter).map((client) => client.connId)),
      logGateway,
    } as never),
    () => projection,
  );
  const controlUi = (connId: string, scopes: string[]) => {
    const client = createOperatorWsClient({
      connId,
      clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
      scopes,
    });
    clients.push(client);
    return client;
  };
  const world = {
    projection,
    context,
    logGateway,
    /** The shared-secret Control UI owner, as on Saturn: system role actor, gateway-owner. */
    owner(connId = "owner-ui") {
      const client = controlUi(connId, ["operator.admin"]);
      client.authenticatedUserId = "owner-user";
      client.authenticatedUserProfile = {
        profileId: GATEWAY_OWNER_PROFILE_ID,
        displayName: "Owner",
        avatarRevision: "r1",
        hasAvatar: false,
        updatedAt: 1,
      };
      attest(client, {
        authenticatedOperator: true,
        authenticatedControlUi: true,
        controlUiAdmin: true,
        operatorRoleActor: { kind: "system" },
      });
      return client;
    },
    /** A role-assigned person on their own authenticated Control UI connection. */
    person(label: string, role: "view" | "write" | "admin") {
      const profile = ensureProfileForEmail(`${label}@example.test`);
      setUserProfileRole(profile.id, role);
      const scopes = role === "admin" ? ["operator.admin"] : ["operator.read", "operator.write"];
      const client = controlUi(`${label}-ui`, scopes);
      client.authenticatedUserId = profile.id;
      client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: label,
        avatarRevision: "r1",
        hasAvatar: false,
        updatedAt: 1,
      };
      attest(client, {
        authenticatedOperator: true,
        authenticatedControlUi: true,
        ...(role === "admin" ? { controlUiAdmin: true as const } : {}),
      });
      prepareGatewayConnectOperatorAccess(client);
      prepareGatewayRecipientProfile(client);
      return { client, profileId: profile.id };
    },
    canPromote(client: GatewayWsClient, key = TARGET) {
      return (
        prepareProjectedSessionPresentation(projection, client).snapshot({
          agentId: "main",
          key,
        }).row?.promotion?.canPromote ?? false
      );
    },
    projected(client: GatewayWsClient, key = TARGET) {
      return prepareProjectedSessionPresentation(projection, client).snapshot({
        agentId: "main",
        key,
      }).row?.promotion;
    },
    async promote(
      client: GatewayWsClient,
      key = TARGET,
      requestId = `${client.connId}-intent`,
      action: "request" | "cancel" = "request",
    ) {
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key })!;
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: requestId,
          method: "sessions.promote",
          params: {
            key,
            expectedSessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
            requestId,
            action,
          },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload, error] = respond.mock.calls[0] as [
        boolean,
        { state?: string } | undefined,
        (
          | { code?: string; message?: string; details?: { code?: string; reason?: string } }
          | undefined
        ),
      ];
      return { ok, payload, error };
    },
    /** Parity: the menu offers exactly what the server accepts, on the same fixture. */
    async promoteWithParity(client: GatewayWsClient, key = TARGET) {
      const offered = world.canPromote(client, key);
      const result = await world.promote(client, key);
      expect(offered, `canPromote must equal acceptance for ${key}`).toBe(result.ok);
      return result;
    },
    loggedReasons() {
      return [...logGateway.info.mock.calls, ...logGateway.warn.mock.calls]
        .map((call) => String(call[0]))
        .filter((line) => line.includes("sessions.promote"))
        .join("\n");
    },
    promotion(key = TARGET) {
      return loadSessionEntry({ agentId: "main", sessionKey: key })!.sessionPromotion;
    },
  };
  return world;
}

const FORBIDDEN = {
  ok: false,
  error: { code: "FORBIDDEN", message: "Session promotion is not available." },
};

describe("an administrator promotes any durable delegated session", () => {
  it("promotes the live agent-created handoff session and activates it in place at settlement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld({});
      try {
        const owner = world.owner();
        const result = await world.promoteWithParity(owner);
        expect(result.error).toBeUndefined();
        expect(result.payload?.state).toBe("pending");
        const outcome = await activateSessionPromotionAfterSettlement({
          context: world.context,
          sessionKey: TARGET,
        });
        expect(outcome).toBe("activated");
        const after = loadSessionEntry({ agentId: "main", sessionKey: TARGET })!;
        expect(after.sessionPromotion).toMatchObject({
          state: "activated",
          profileId: GATEWAY_OWNER_PROFILE_ID,
        });
        expect(after.sessionId).toBe(TARGET.replaceAll(":", "-"));
        expect(after.parentSessionKey).toBe(MOLTING);
        expect(after.createdActor).toEqual(agentActor);
        expect(after.lifecycleRevision).not.toBe("before");
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("promotes a subagent-key task session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld({});
      try {
        const result = await world.promoteWithParity(world.owner(), SUBAGENT);
        expect(result).toMatchObject({ ok: true, payload: { state: "pending" } });
        expect(
          await activateSessionPromotionAfterSettlement({
            context: world.context,
            sessionKey: SUBAGENT,
          }),
        ).toBe("activated");
        expect(world.promotion(SUBAGENT)).toMatchObject({ state: "activated" });
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("promotes as a role-assigned administrator, and ends the intent when admin is revoked", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld(rolesConfig);
      try {
        const ada = world.person("ada", "admin");
        expect(await world.promoteWithParity(ada.client)).toMatchObject({
          ok: true,
          payload: { state: "pending" },
        });
        // The original basis included operator.admin; the role no longer grants it.
        setUserProfileRole(ada.profileId, "write");
        expect(
          await activateSessionPromotionAfterSettlement({
            context: world.context,
            sessionKey: TARGET,
          }),
        ).toBe("revoked");
        expect(world.promotion()).toMatchObject({ state: "revoked" });
        // A later regrant does not revive the ended intent.
        setUserProfileRole(ada.profileId, "admin");
        expect(
          await activateSessionPromotionAfterSettlement({
            context: world.context,
            sessionKey: TARGET,
          }),
        ).toBe("unchanged");
        expect(world.promotion()).toMatchObject({ state: "revoked" });
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("refuses incognito sessions as unsupported, even for an administrator", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      await seed(INCOGNITO, { ...delegatedBy(MOLTING), incognito: true });
      const world = await createWorld({});
      try {
        const result = await world.promoteWithParity(world.owner(), INCOGNITO);
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            details: { code: "SESSION_PROMOTION_UNSUPPORTED", reason: "incognito" },
          },
        });
        expect(world.promotion(INCOGNITO)).toBeUndefined();
        expect(world.loggedReasons()).toMatch(/reason=unsupported-target:incognito/);
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("names a never-delegated session as having nothing to promote", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld({});
      try {
        const result = await world.promoteWithParity(world.owner(), HOME);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { reason: "not-delegated" } },
        });
        expect(world.projected(world.owner("owner-ui-2"), HOME)?.disabledReasons).toContain(
          "unsupported-target:not-delegated",
        );
      } finally {
        await world.projection.dispose();
      }
    });
  });
});

describe("everyone else is refused with the same non-disclosing denial", () => {
  it("refuses a non-admin other human and a restricted role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld(rolesConfig);
      try {
        const writer = world.person("bob", "write");
        const viewer = world.person("vera", "view");
        for (const key of [TARGET, SUBAGENT]) {
          // A writer reaches the handler, which refuses without naming the rule.
          expect(await world.promoteWithParity(writer.client, key)).toMatchObject(FORBIDDEN);
          // A view-capped role is already refused by router session-sharing admission.
          expect(await world.promoteWithParity(viewer.client, key)).toMatchObject({
            ok: false,
            error: { code: "INVALID_REQUEST", details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
          });
        }
        expect(world.loggedReasons()).toMatch(/reason=lineage-denied/);
        expect(world.promotion()).toBeUndefined();
        expect(world.promotion(SUBAGENT)).toBeUndefined();
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("refuses a model or tool caller that carries admin scopes and owner attribution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld({});
      try {
        const tool = world.owner("tool-ui");
        attest(tool, { ...tool.internal, agentToolCaller: { sessionKey: TARGET } as never });
        const runtime = world.owner("runtime-ui");
        attest(runtime, {
          ...runtime.internal,
          agentRuntimeIdentity: { sessionKey: TARGET } as never,
        });
        // Through the router: refused (runtime callers already at participant admission).
        for (const client of [tool, runtime]) {
          const result = await world.promoteWithParity(client);
          expect(result.ok).toBe(false);
          expect(["FORBIDDEN", "INVALID_REQUEST"]).toContain(result.error?.code);
        }
        // The handler's own human predicate refuses both, independent of router admission.
        for (const client of [tool, runtime]) {
          const respond = vi.fn();
          const entry = loadSessionEntry({ agentId: "main", sessionKey: TARGET })!;
          await sessionPromotionHandlers["sessions.promote"]!({
            req: { type: "req", id: "direct", method: "sessions.promote" },
            params: {
              key: TARGET,
              expectedSessionId: entry.sessionId,
              expectedLifecycleRevision: entry.lifecycleRevision,
              requestId: "direct",
            },
            client,
            context: world.context,
            respond,
            isWebchatConnect: () => false,
          } as never);
          expect(respond).toHaveBeenCalledWith(false, undefined, FORBIDDEN.error);
        }
        expect(world.loggedReasons()).toMatch(/reason=not-control-ui-human/);
        expect(world.promotion()).toBeUndefined();
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("gives an admin-scoped connection without the attested Control UI admin flag no admin path", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const carolProfile = ensureProfileForEmail("carol@example.test");
      // Rooted in another person's session: only the admin path could reach it.
      await seedLiveTree({
        key: "agent:main:dashboard:carol-root",
        entry: { createdActor: { type: "human", source: "profile", id: carolProfile.id } },
      });
      const world = await createWorld({});
      try {
        const owner = world.owner("owner-no-admin-flag");
        attest(owner, { ...owner.internal, controlUiAdmin: undefined });
        expect(await world.promoteWithParity(owner)).toMatchObject(FORBIDDEN);
        expect(world.loggedReasons()).toMatch(/reason=lineage-denied/);
        expect(await world.promoteWithParity(world.owner())).toMatchObject({ ok: true });
      } finally {
        await world.projection.dispose();
      }
    });
  });
});

describe("non-admin promotion through owned lineage", () => {
  it("follows a lineage rooted in a person's own session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const carolProfile = ensureProfileForEmail("carol@example.test");
      const root = "agent:main:dashboard:carol-root";
      await seedLiveTree({
        key: root,
        entry: { createdActor: { type: "human", source: "profile", id: carolProfile.id } },
      });
      const world = await createWorld(rolesConfig);
      try {
        const dave = world.person("dave", "write");
        expect(await world.promoteWithParity(dave.client)).toMatchObject(FORBIDDEN);
        // A write role passes router sharing admission; lineage then decides.
        const carol = world.person("carol", "write");
        expect(await world.promoteWithParity(carol.client)).toMatchObject({ ok: true });
        // Non-admins stay on durable dashboard conversations.
        expect(await world.promoteWithParity(carol.client, SUBAGENT)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { reason: "dashboard-only" } },
        });
        // The administrator may promote it regardless of whose lineage it is.
        expect(await world.promoteWithParity(world.owner(), SUBAGENT)).toMatchObject({
          ok: true,
        });
      } finally {
        await world.projection.dispose();
      }
    });
  });

  it("refuses a lineage that cannot be read to its root", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(TARGET, delegatedBy("agent:main:dashboard:missing"));
      const world = await createWorld(rolesConfig);
      try {
        const bob = world.person("bob", "write");
        expect(await world.promoteWithParity(bob.client)).toMatchObject(FORBIDDEN);
        expect(world.loggedReasons()).toMatch(/reason=lineage-unreadable/);
      } finally {
        await world.projection.dispose();
      }
    });
  });
});

describe("cancelling a pending intent", () => {
  it("lets the original requester and the gateway owner cancel; other admins and people are refused", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedLiveTree();
      const world = await createWorld(rolesConfig);
      try {
        const ada = world.person("ada", "admin");
        const grace = world.person("grace", "admin");
        const bob = world.person("bob", "write");
        const owner = world.owner();

        // The original requester cancels her own intent, reusing its requestId.
        expect(await world.promote(ada.client, SUBAGENT, "ada-sub")).toMatchObject({
          ok: true,
          payload: { state: "pending" },
        });
        for (const refused of [grace.client, bob.client]) {
          expect(await world.promote(refused, SUBAGENT, "ada-sub", "cancel")).toMatchObject(
            FORBIDDEN,
          );
          expect(world.promotion(SUBAGENT)).toMatchObject({
            state: "pending",
            requestId: "ada-sub",
          });
        }
        expect(await world.promote(ada.client, SUBAGENT, "ada-sub", "cancel")).toMatchObject({
          ok: true,
        });
        expect(world.promotion(SUBAGENT)).toMatchObject({ state: "cancelled" });

        // The gateway owner may cancel someone else's intent, but another admin may not.
        expect(await world.promote(ada.client, TARGET, "ada-intent")).toMatchObject({
          ok: true,
          payload: { state: "pending" },
        });
        expect(await world.promote(grace.client, TARGET, "ada-intent", "cancel")).toMatchObject(
          FORBIDDEN,
        );
        expect(world.promotion()).toMatchObject({ state: "pending", requestId: "ada-intent" });
        expect(await world.promote(owner, TARGET, "ada-intent", "cancel")).toMatchObject({
          ok: true,
        });
        expect(world.promotion()).toMatchObject({ state: "cancelled" });
      } finally {
        await world.projection.dispose();
      }
    });
  });
});

describe("an admin-only intent whose admin basis was removed", () => {
  it("is revoked at settlement and stays cancellable by its requester, granting nothing", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const SECOND = "agent:main:subagent:worker-2";
      await seedLiveTree();
      await seed(SECOND, delegatedBy(MOLTING));
      // Operator roles are configured when Ada, an administrator, requests both intents.
      const before = await createWorld(rolesConfig);
      try {
        const ada = before.person("ada", "admin");
        for (const [key, requestId] of [
          [SUBAGENT, "ada-sub"],
          [SECOND, "ada-second"],
        ]) {
          expect(await before.promote(ada.client, key, requestId)).toMatchObject({
            ok: true,
            payload: { state: "pending" },
          });
        }
      } finally {
        await before.projection.dispose();
      }
      // The roles configuration is removed: Ada's admin basis can no longer be restored.
      const after = await createWorld({});
      try {
        expect(
          await activateSessionPromotionAfterSettlement({
            context: after.context,
            sessionKey: SUBAGENT,
          }),
        ).toBe("revoked");
        expect(after.promotion(SUBAGENT)).toMatchObject({ state: "revoked" });
        expect(loadSessionEntry({ agentId: "main", sessionKey: SUBAGENT })).toMatchObject({
          lifecycleRevision: "before",
        });

        // Ada, no longer an administrator anywhere, cancels her own intent; others cannot.
        const ada = after.person("ada", "write");
        const bob = after.person("bob", "write");
        expect(await after.promote(bob.client, SECOND, "ada-second", "cancel")).toMatchObject(
          FORBIDDEN,
        );
        expect(after.promotion(SECOND)).toMatchObject({ state: "pending" });
        expect(await after.promote(ada.client, SECOND, "ada-second", "cancel")).toMatchObject({
          ok: true,
          payload: { state: "cancelled" },
        });
        expect(loadSessionEntry({ agentId: "main", sessionKey: SECOND })).toMatchObject({
          lifecycleRevision: "before",
        });
      } finally {
        await after.projection.dispose();
      }
    });
  });
});
