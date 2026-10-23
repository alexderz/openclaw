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
  constructor(options?: ErrorOptions) {
    super(
      "Session delivery generation is unavailable; retry after session storage is ready.",
      options,
    );
    this.name = "SessionDeliveryGenerationUnavailableError";
  }
}

export const isSessionDeliveryGenerationRevokedError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_REVOKED";
export const isSessionDeliveryGenerationUnavailableError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_UNAVAILABLE";

/** Typed lease failures pass through; anything else is an unavailable read with its cause. */
export function normalizeSessionDeliveryGenerationFailure(error: unknown) {
  return isSessionDeliveryGenerationRevokedError(error) ||
    isSessionDeliveryGenerationUnavailableError(error)
    ? error
    : new SessionDeliveryGenerationUnavailableError({ cause: error });
}

/** Normalize a lease failure and notify the execution owner before it is thrown or rejected. */
export function createSessionDeliveryGenerationFailureReporter(
  onRevoked?: (reason: unknown) => void,
) {
  return (error: unknown) => {
    const failure = normalizeSessionDeliveryGenerationFailure(error);
    onRevoked?.(failure);
    return failure;
  };
}
