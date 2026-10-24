import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { getSafeSessionStorage } from "../local-storage.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";
import { isControlUiDocumentReachable } from "./stale-chunk-reload.ts";

// A slow update check must not make the menu item feel dead.
const WORKER_SETTLE_TIMEOUT_MS = 4_000;
const RECONCILE_AFTER_RELOAD_KEY = "openclaw.controlUi.reconcileAfterReload";
// Only the document this reload opens heals from it, not a later restore.
const RECONCILE_AFTER_RELOAD_WINDOW_MS = 60_000;

type ManualReloadDeps = {
  serviceWorker?: Pick<ServiceWorkerContainer, "getRegistration"> | null;
  reload?: () => void;
  canReload?: () => boolean;
  isReachable?: () => Promise<boolean>;
  onUnreachable?: () => void;
  storage?: Pick<Storage, "setItem"> | null;
  timeoutMs?: number;
  now?: () => number;
};

function settled(worker: ServiceWorker | null | undefined, timeoutMs: number): Promise<void> {
  if (!worker || worker.state === "activated" || worker.state === "redundant") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (worker.state === "activated" || worker.state === "redundant") {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    worker.addEventListener("statechange", onStateChange);
  });
}

function defaultServiceWorker() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator
    ? navigator.serviceWorker
    : null;
}

/** True once per chat for the document a manual reload opened. */
export function readReconcileAfterReload(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = getSafeSessionStorage(),
  now = Date.now(),
): boolean {
  try {
    const at = Number(storage?.getItem(RECONCILE_AFTER_RELOAD_KEY));
    storage?.removeItem(RECONCILE_AFTER_RELOAD_KEY);
    return Number.isFinite(at) && at > 0 && now - at < RECONCILE_AFTER_RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * The user asked for a fresh document. An installed PWA has no browser reload
 * button, so check for a newer worker first and let a waiting one take over;
 * the worker skips waiting on install, so activation needs no message. The
 * reloaded document reads every chat in full once, healing drift that a
 * stored delta cursor would otherwise carry over.
 */
export async function reloadControlUiManually(deps: ManualReloadDeps = {}): Promise<boolean> {
  // Memory-only work (uploads, unsent recordings) explains itself and stays.
  const canReload = deps.canReload ?? (() => canReloadControlUiDocument(true));
  if (!canReload()) {
    return false;
  }
  const timeoutMs = deps.timeoutMs ?? WORKER_SETTLE_TIMEOUT_MS;
  try {
    const registration = await (deps.serviceWorker ?? defaultServiceWorker())?.getRegistration();
    if (registration) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        registration.update().catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      await settled(registration.installing ?? registration.waiting, timeoutMs);
    }
  } catch (error) {
    console.warn("OpenClaw service worker check failed before reload.", error);
  }
  // A PWA has no browser chrome to recover from an error page.
  if (!(await (deps.isReachable ?? (() => isControlUiDocumentReachable()))())) {
    (deps.onUnreachable ?? (() => showToast({ message: t("connection.reloadUnreachable") })))();
    return false;
  }
  if (!canReload()) {
    return false;
  }
  try {
    (deps.storage === undefined ? getSafeSessionStorage() : deps.storage)?.setItem(
      RECONCILE_AFTER_RELOAD_KEY,
      String((deps.now ?? Date.now)()),
    );
  } catch {
    // Healing still happens on the next chat re-entry.
  }
  // The worker never caches the document, so a plain reload fetches the new build.
  (deps.reload ?? (() => window.location.reload()))();
  return true;
}
