import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

describe("session creation parent links", () => {
  it("refuses to re-parent an existing session and keeps its stored parent link", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await state.writeConfig(cfg);
      const common = { cfg, commandSource: "test", operatorRoleActor: { kind: "system" as const } };
      const parentA = "agent:main:dashboard:parent-a";
      const parentB = "agent:main:dashboard:parent-b";
      const childKey = "agent:main:dashboard:child";
      for (const key of [parentA, parentB]) {
        const created = await createGatewaySession({ ...common, key });
        if (!created.ok) {
          throw new Error(created.error.message);
        }
      }
      const child = await createGatewaySession({
        ...common,
        key: childKey,
        parentSessionKey: parentA,
      });
      if (!child.ok) {
        throw new Error(child.error.message);
      }

      const moved = await createGatewaySession({
        ...common,
        key: childKey,
        parentSessionKey: parentB,
      });

      expect(moved).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "parentSessionKey cannot change on an existing session",
        },
      });
      expect(loadSessionEntry({ sessionKey: childKey })?.parentSessionKey).toBe(parentA);
    });
  });
});
