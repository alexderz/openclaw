/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { readReconcileAfterReload, reloadControlUiManually } from "./manual-reload.ts";

const reachable = { isReachable: async () => true, storage: null };

function worker(state: ServiceWorkerState) {
  const target = new EventTarget() as ServiceWorker & { state: ServiceWorkerState };
  Object.defineProperty(target, "state", { value: state, writable: true });
  return target;
}

function container(registration: Partial<ServiceWorkerRegistration> | undefined) {
  return {
    getRegistration: vi.fn(async () => registration as ServiceWorkerRegistration | undefined),
  };
}

describe("manual reload", () => {
  it("lets a newer worker take over before reloading the document", async () => {
    const replacement = worker("installing");
    const registration = {
      installing: null as ServiceWorker | null,
      waiting: null,
      update: vi.fn(async () => {
        registration.installing = replacement;
        return registration as unknown as ServiceWorkerRegistration;
      }),
    };
    const reload = vi.fn();
    const done = reloadControlUiManually({
      serviceWorker: container(registration),
      reload,
      canReload: () => true,
      ...reachable,
    });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    (replacement as { state: ServiceWorkerState }).state = "activated";
    replacement.dispatchEvent(new Event("statechange"));
    await expect(done).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads without a service worker and when the update check fails", async () => {
    const reload = vi.fn();
    await expect(
      reloadControlUiManually({ serviceWorker: null, reload, canReload: () => true, ...reachable }),
    ).resolves.toBe(true);
    const failing = {
      installing: null,
      waiting: null,
      update: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    await expect(
      reloadControlUiManually({
        serviceWorker: container(failing),
        reload,
        canReload: () => true,
        ...reachable,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not wait forever for a stuck worker", async () => {
    const reload = vi.fn();
    const registration = {
      installing: worker("installing"),
      waiting: null,
      update: vi.fn(() => new Promise<ServiceWorkerRegistration>(() => {})),
    };
    await expect(
      reloadControlUiManually({
        serviceWorker: container(registration),
        reload,
        canReload: () => true,
        timeoutMs: 5,
        ...reachable,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the page when memory-only work blocks a reload", async () => {
    const reload = vi.fn();
    const serviceWorker = container(undefined);
    await expect(
      reloadControlUiManually({ serviceWorker, reload, canReload: () => false }),
    ).resolves.toBe(false);
    expect(serviceWorker.getRegistration).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the app open when the Gateway is unreachable", async () => {
    const reload = vi.fn();
    const onUnreachable = vi.fn();
    await expect(
      reloadControlUiManually({
        serviceWorker: null,
        reload,
        canReload: () => true,
        isReachable: async () => false,
        onUnreachable,
        storage: null,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onUnreachable).toHaveBeenCalledOnce();
  });

  it("asks the reloaded document for one full read per chat", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    await reloadControlUiManually({
      serviceWorker: null,
      reload: vi.fn(),
      canReload: () => true,
      isReachable: async () => true,
      storage,
      now: () => 1_000,
    });
    expect(readReconcileAfterReload(storage, 2_000)).toBe(true);
    // Consumed: a later restore of the same tab does not repeat it.
    expect(readReconcileAfterReload(storage, 2_000)).toBe(false);
    storage.setItem("openclaw.controlUi.reconcileAfterReload", "1000");
    expect(readReconcileAfterReload(storage, 120_000)).toBe(false);
  });
});
