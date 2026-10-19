/**
 * Session keys that hold a persisted pending promotion intent on this Gateway. Settlement attempts
 * run only for members: a request or the startup scan adds a key, and an activation, revocation or
 * cancellation removes it. Process-local, so a restart rebuilds it from the stores.
 */
const pendingKeys = new Set<string>();

export function markSessionPromotionPending(sessionKey: string): void {
  pendingKeys.add(sessionKey);
}

export function clearSessionPromotionPending(sessionKey: string): void {
  pendingKeys.delete(sessionKey);
}

export function isSessionPromotionPending(sessionKey: string): boolean {
  return pendingKeys.has(sessionKey);
}
