/** Worker code is part of the deployed client, not a long-lived account store. */
export const WORKER_UPDATED_EVENT = "0media-worker-updated";
let startup: Promise<void> | undefined;
const INTERCEPTION_HEADER = "x-0media-video-bridge";

/** A worker answering messages does not establish fetch interception. Run this
 * in the app's own world, not an automation/extension's isolated world. */
export async function videoWorkerIntercepts(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    // Deliberately invalid token: no account, media lease, or upstream request.
    const pending = fetch("/_0media/video/probe", {
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal,
    });
    const response = await new Promise<Response>((resolve, reject) => {
      const interrupted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", interrupted, { once: true });
      void pending.then(value => {
        controller.signal.removeEventListener("abort", interrupted);
        if (controller.signal.aborted) { void value.body?.cancel().catch(() => undefined); reject(controller.signal.reason); }
        else resolve(value);
      }, error => { controller.signal.removeEventListener("abort", interrupted); reject(error); });
      if (controller.signal.aborted) interrupted();
    });
    void response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
    return response.status === 410 && response.headers.get(INTERCEPTION_HEADER) === "3";
  } catch { signal.throwIfAborted(); return false; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", stop); controller.abort(); }
}

export function updateApplicationWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return Promise.resolve();
  return startup ??= navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
    // Also check imported scripts. An already-active worker at the right URL
    // can still contain an older video bridge after a hard refresh.
    .then(registration => registration.update())
    .then(() => { window.dispatchEvent(new Event(WORKER_UPDATED_EVENT)); })
    .catch(() => undefined);
}
