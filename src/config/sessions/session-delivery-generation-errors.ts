import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Shared failure classes for session delivery generation leases. */
export class SessionDeliveryGenerationRevokedError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_REVOKED";
  constructor() {
    super("The original session generation no longer accepts this delivery.");
    this.name = "SessionDeliveryGenerationRevokedError";
  }
}

export class SessionDeliveryGenerationUnavailableError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_UNAVAILABLE";
  /**
   * True only while a live, unrevoked lease waits on another writer's publication or
   * native transaction: the same lease can become current again without being re-prepared.
   */
  readonly pending: boolean;
  constructor(options?: ErrorOptions & { pending?: boolean }) {
    super(
      "Session delivery generation is unavailable; retry after session storage is ready.",
      options,
    );
    this.name = "SessionDeliveryGenerationUnavailableError";
    this.pending = options?.pending === true;
  }
}

export const isSessionDeliveryGenerationRevokedError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_REVOKED";
export const isSessionDeliveryGenerationUnavailableError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_UNAVAILABLE";
export const isSessionDeliveryGenerationPendingError = (error: unknown) =>
  isSessionDeliveryGenerationUnavailableError(error) && isRecord(error) && error.pending === true;

/** Typed lease failures pass through; anything else is an unavailable read with its cause. */
export function normalizeSessionDeliveryGenerationFailure(error: unknown) {
  return isSessionDeliveryGenerationRevokedError(error) ||
    isSessionDeliveryGenerationUnavailableError(error)
    ? error
    : new SessionDeliveryGenerationUnavailableError({ cause: error });
}

/** Normalizes a lease failure; a pending window refuses one check without revoking its owner. */
export function reportSessionDeliveryGenerationFailure(
  error: unknown,
  onRevoked: ((reason: unknown) => void) | undefined,
) {
  const failure = normalizeSessionDeliveryGenerationFailure(error);
  if (!isSessionDeliveryGenerationPendingError(failure)) {
    onRevoked?.(failure);
  }
  return failure;
}
