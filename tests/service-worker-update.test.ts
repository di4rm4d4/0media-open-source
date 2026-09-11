import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

afterEach(() => { delete (navigator as any).serviceWorker; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("updates imported worker code without cache and shares one startup check", async () => {
  vi.resetModules();
  const update = vi.fn(async () => undefined);
  const register = vi.fn(async () => ({ update }));
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
  const events = vi.spyOn(window, "dispatchEvent");
  const { updateApplicationWorker } = await import("../transport/media/worker-lifecycle");
  await Promise.all([updateApplicationWorker(), updateApplicationWorker()]);
  expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { updateViaCache: "none" });
  expect(update).toHaveBeenCalledOnce();
  expect(events.mock.calls.some(([event]) => event.type === "0media-worker-updated")).toBe(true);
});

it("keeps a failed worker update from rejecting application startup", async () => {
  vi.resetModules();
  const register = vi.fn(async () => { throw new Error("offline"); });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
  const { updateApplicationWorker } = await import("../transport/media/worker-lifecycle");
  await expect(updateApplicationWorker()).resolves.toBeUndefined();
});

it("acknowledges claim success and failure only to a same-origin source", async () => {
  let listener!: (event: any) => void;
  const claim = vi.fn().mockResolvedValue(undefined);
  const worker = { location, clients: { claim }, addEventListener: (kind: string, callback: any) => { if (kind === "message") listener = callback; } };
  new Function("self", readFileSync("public/video-sw.js", "utf8"))(worker);
  const reply = vi.fn();
  let pending!: Promise<void>;
  const event = { source: { url: location.href, postMessage: reply }, ports: [],
    data: { protocol: "0media-video-v1", kind: "claim" }, waitUntil: (promise: Promise<void>) => { pending = promise; } };
  listener(event); await pending;
  expect(reply).toHaveBeenLastCalledWith({ protocol: "0media-video-v1", kind: "claim-result", version: 3, ok: true });
  claim.mockRejectedValueOnce(new Error("unavailable"));
  listener(event); await pending;
  expect(reply).toHaveBeenLastCalledWith({ protocol: "0media-video-v1", kind: "claim-result", version: 3, ok: false });
  listener({ ...event, source: { ...event.source, url: "https://example.org/" } });
  listener({ ...event, ports: [{}] });
  expect(claim).toHaveBeenCalledTimes(2);
  expect(reply).toHaveBeenCalledTimes(2);
});

it.each([
  [410, { "x-0media-video-bridge": "3" }, true],
  [410, { "cf-ray": "offline-edge" }, false],
  [410, { "x-0media-video-bridge": "2" }, false],
  [200, { "x-0media-video-bridge": "3" }, false],
])("checks actual fixed-path interception (%s, %j)", async (status, headers, expected) => {
  const fetch = vi.fn(async () => new Response(null, { status, headers }));
  vi.stubGlobal("fetch", fetch);
  const { videoWorkerIntercepts } = await import("../transport/media/worker-lifecycle");
  expect(await videoWorkerIntercepts(new AbortController().signal)).toBe(expected);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/_0media/video/probe", expect.objectContaining({
    credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error",
  }));
});

it("bounds an interception check even if its fetch ignores abort, and cancels a late body", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const { videoWorkerIntercepts } = await import("../transport/media/worker-lifecycle");
  const pending = videoWorkerIntercepts(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1501);
  expect(await pending).toBe(false);
  const cancel = vi.fn();
  finish(new Response(new ReadableStream({ cancel }), { status: 410 }));
  await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels an interception check without publishing readiness", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const { videoWorkerIntercepts } = await import("../transport/media/worker-lifecycle");
  const owner = new AbortController();
  const pending = videoWorkerIntercepts(owner.signal);
  owner.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
