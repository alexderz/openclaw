import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeSessionIdentities } from "./session-lifecycle-identity.js";

type ReservationWatch = { identities: Set<string>; reserved: boolean };

// Shared across runtime chunks, like the admission state that reports into it.
const watches = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionWorkAdmissionReservationWatches"),
  () => new Set<ReservationWatch>(),
);

export type SessionWorkAdmissionReservationWatcher = {
  /** Extends the watch, for example to a descendant session in another store. */
  add: (scope: string, identities: Iterable<string | undefined>) => void;
  /** Whether any work admission was reserved for a watched identity since it was added. */
  reserved: () => boolean;
  stop: () => void;
};

/**
 * Read-only observation for an owner that inventories work outside the lifecycle fence and must
 * know, at its synchronous commit, whether ingress arrived meanwhile, even if that admission has
 * already acquired and released. It never blocks or delays admission. Callers must stop it.
 */
export function watchSessionWorkAdmissionReservations(): SessionWorkAdmissionReservationWatcher {
  const watch: ReservationWatch = { identities: new Set(), reserved: false };
  watches.add(watch);
  return {
    add: (scope, identities) => {
      for (const identity of normalizeSessionIdentities(scope, identities)) {
        watch.identities.add(identity);
      }
    },
    reserved: () => watch.reserved,
    stop: () => {
      watches.delete(watch);
    },
  };
}

/** Called by the admission owner when it reserves already-normalized identities. */
export function noteSessionWorkAdmissionReserved(identities: readonly string[]): void {
  for (const watch of watches) {
    if (!watch.reserved && identities.some((identity) => watch.identities.has(identity))) {
      watch.reserved = true;
    }
  }
}
