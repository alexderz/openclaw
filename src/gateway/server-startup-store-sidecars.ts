import type { GatewayRequestContext } from "./server-methods/types.js";

type IntegrityVerifier = ReturnType<
  typeof import("../state/openclaw-database-verify.js").startOpenClawDatabaseIntegrityVerifier
>;
type PromotionSettlement = ReturnType<
  typeof import("./session-promotion-settlement.js").startSessionPromotionSettlement
>;

/** Store-owned lifetime sidecars that start once the listener is bound, in this order. */
export async function startGatewayStoreSidecars(
  register: (sidecar: IntegrityVerifier | PromotionSettlement) => void,
  context: GatewayRequestContext,
  log: { warn: (message: string) => void },
): Promise<void> {
  const { startOpenClawDatabaseIntegrityVerifier } =
    await import("../state/openclaw-database-verify.js");
  register(startOpenClawDatabaseIntegrityVerifier({ env: process.env }));
  const { startSessionPromotionSettlement } = await import("./session-promotion-settlement.js");
  register(startSessionPromotionSettlement(context, log));
}
