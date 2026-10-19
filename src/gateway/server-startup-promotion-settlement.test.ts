import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

function createStartupTestState(label: string) {
  return createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
}

describe("Gateway promotion settlement wiring", () => {
  it("starts owner-release promotion settlement at startup and stops it with the Gateway", async () => {
    const state = await createStartupTestState("gateway-promotion-settlement-wiring");
    const stop = vi.fn();
    const settlementModule = await import("./session-promotion-settlement.js");
    const start = vi
      .spyOn(settlementModule, "startSessionPromotionSettlement")
      .mockReturnValue({ stop });
    const token = "gateway-promotion-settlement-token";
    try {
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false } },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      const server = await startGatewayServerCore(await getFreePort(), {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      await server.startupSettled;
      expect(start).toHaveBeenCalledOnce();
      const [context, log] = start.mock.calls[0];
      expect(typeof context.getRuntimeConfig).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(stop).not.toHaveBeenCalled();
      await server.close();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      start.mockRestore();
      await state.cleanup();
    }
  });
});
