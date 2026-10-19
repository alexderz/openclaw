import { createHash } from "node:crypto";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { isControlUiHumanClient } from "./session-promotion-client.js";

/** `reason` is a server-log diagnostic code only; clients always see the same denial. */
export class PromotionRequesterDeniedError extends Error {
  constructor(readonly reason = "not-control-ui-human") {
    super(`Session promotion requester refused: ${reason}`);
  }
}

export type FreshHumanPromotionRequester = Readonly<{
  profileId: string;
  /** Device the connection authenticated with, when it presented one. */
  deviceId?: string;
  assertCurrent: () => void;
}>;

/**
 * Only an exact, live, host-attested Control UI human may originate or consume promotion
 * intent. Attribution, owner scopes, inherited hints and wire client ids are not authority.
 * Throws PromotionRequesterDeniedError for anything else; the guard re-checks on every call.
 */
export function prepareFreshHumanPromotionRequester(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "sessionMutationAuthorization"
  >,
): FreshHumanPromotionRequester {
  const { client, context } = options;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const connId = client?.connId;
  const originalActor = resolveGatewayOperatorRoleActor(client);
  const actor = originalActor ? { ...originalActor } : undefined;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.sessionMutationAuthorization?.assertCurrent();
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      !client ||
      !connId ||
      !isControlUiHumanClient(client) ||
      currentActor?.kind !== actor?.kind ||
      (actor?.kind === "operator" &&
        (currentActor?.kind !== "operator" || currentActor.profileId !== actor.profileId)) ||
      !profileId ||
      client.authenticatedUserProfile?.profileId !== profileId ||
      client.authenticatedUserId !== userId ||
      client.connId !== connId ||
      !context.getClientConnIds?.((current) => current === client).has(connId)
    ) {
      throw new PromotionRequesterDeniedError();
    }
  };
  assertCurrent();
  const deviceId = client?.connect.device?.id?.trim();
  return Object.freeze({
    profileId: profileId!,
    ...(deviceId ? { deviceId } : {}),
    assertCurrent,
  });
}

/** Non-throwing profile read for admission snapshots: undefined means "not a fresh human". */
export function resolveFreshHumanPromotionProfileId(
  options: Parameters<typeof prepareFreshHumanPromotionRequester>[0],
): string | undefined {
  try {
    return prepareFreshHumanPromotionRequester(options).profileId;
  } catch (error) {
    if (error instanceof PromotionRequesterDeniedError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Pairing incarnation of a device: kept by re-approval or scope changes, replaced when the
 * device is unpaired and paired again (new `createdAtMs`) or re-keyed by a new installation.
 */
export function promotionDeviceGeneration(
  device: Pick<PairedDevice, "createdAtMs" | "publicKey">,
): string {
  const key = createHash("sha256").update(device.publicKey).digest("base64url");
  return `${device.createdAtMs}:${key}`;
}

/**
 * The pairing record of a promotion's device. Null only when a present pairing database lacks
 * the device; the read-only loader also answers null for a missing database, which proves
 * nothing, so that case throws like any other unreadable pairing state.
 */
export async function readPromotionPairedDevice(deviceId: string): Promise<PairedDevice | null> {
  const device = await getPairedDevice(deviceId);
  if (!device && !existingPathOrUndefined(resolveOpenClawStateSqlitePath())) {
    throw new Error("Device pairing database is unavailable");
  }
  return device;
}

/**
 * The device binding a promotion request records. Undefined when the connection presented no
 * device or the pairing store says it is not paired: then only the operator grant can end the
 * basis. Throws when pairing state cannot be read, so the caller refuses instead of recording
 * an unprovable "no device".
 */
export async function readPromotionDeviceBinding(
  deviceId: string | undefined,
): Promise<{ id: string; generation: string } | undefined> {
  if (!deviceId) {
    return undefined;
  }
  const device = await readPromotionPairedDevice(deviceId);
  return device ? { id: deviceId, generation: promotionDeviceGeneration(device) } : undefined;
}
