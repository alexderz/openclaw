import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Listener = (identities: readonly string[]) => void;

const listeners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionWorkSettlementListeners"),
  () => new Set<Listener>(),
);

/** A work owner released custody of these logical session identities (keys, ids, aliases). */
export function notifySessionWorkSettled(identities: Iterable<string | undefined>): void {
  const settled = [...new Set([...identities].filter((id): id is string => Boolean(id)))];
  if (settled.length === 0 || listeners.size === 0) {
    return;
  }
  // Never run listener code inside the releasing owner's critical section.
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(settled);
      } catch {
        // A listener failure cannot affect the owner that settled.
      }
    }
  });
}

export function onSessionWorkSettled(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Counts distinct admissions by phase across already-normalized identities (read only). */
export function countAdmissionPhases<T extends { phase: "pending" | "acquired" }>(
  active: ReadonlyMap<string, ReadonlySet<T>>,
  identities: Iterable<string>,
): { pending: number; acquired: number } {
  const seen = new Set<T>();
  for (const identity of identities) {
    active.get(identity)?.forEach((admission) => seen.add(admission));
  }
  const pending = [...seen].filter((admission) => admission.phase === "pending").length;
  return { pending, acquired: seen.size - pending };
}
