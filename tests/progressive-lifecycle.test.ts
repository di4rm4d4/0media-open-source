// Synthetic page/worker messages, never a real browser or CDN connection.
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const source = "https://example.com/offline.mp4";
const cleanup: Array<() => void> = [];
let worker: any, sw: any;
let bridge: typeof import("../transport/media/video-bridge");
function channel() {
  const value = new NodeMessageChannel();
  cleanup.push(() => { value.port1.close(); value.port2.close(); });
  return value;
}
function response() {
  return new Response(new Uint8Array([0, 1]), { status: 206,
    headers: { "content-type": "video/mp4", "content-range": "bytes 0-1/100", "content-length": "2", etag: '"offline"' } });
}
beforeEach(async () => {
  vi.resetModules();
  const listeners = new Map<string, Array<(event: any) => void>>();
  worker = { scriptURL: new URL("/sw.js", location.origin).href, reply: true,
    postMessage: vi.fn((data: any, ports: any[]) => {
      if (worker.reply) { ports[0].postMessage({ protocol: data.protocol, kind: "ready", version: 3 }); ports[0].close(); }
      else cleanup.push(() => ports[0].close());
    }),
  };
  sw = { controller: worker,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const callbacks = listeners.get(type) ?? []; callbacks.push(listener); listeners.set(type, callbacks);
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener));
    },
    emit: (type: string, event: any = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410, headers: { "x-0media-video-bridge": "3" } })));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  bridge = await import("../transport/media/video-bridge");
});
afterEach(() => {
  cleanup.splice(0).reverse().forEach(close => close());
  delete (navigator as any).serviceWorker;
  vi.unstubAllGlobals(); vi.useRealTimers();
});

it("allows a later explicit attempt after a temporary worker probe timeout", async () => {
  worker.reply = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fetch = vi.fn(async () => response());
  const initial = bridge.progressiveVideo(fetch, source, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2001);
  expect(await initial).toBeUndefined();
  vi.useRealTimers(); worker.reply = true;
  const retry = await bridge.progressiveVideo(fetch, source, new AbortController().signal);
  if (retry) cleanup.push(() => retry.release());
  expect(retry).toBeDefined();
  expect(retry!.url).toContain("/_0media/video/");
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
});

it("reclaims an installed worker after hard reload before starting a native range", async () => {
  sw.controller = null;
  sw.getRegistration = vi.fn(async () => ({ active: worker }));
  const original = worker.postMessage.getMockImplementation();
  worker.postMessage.mockImplementation((data: any, ports: any[]) => {
    if (data.kind === "claim") { sw.controller = worker; sw.emit("controllerchange"); return; }
    return original(data, ports);
  });
  const fetch = vi.fn(async () => response());
  const lease = await bridge.progressiveVideo(fetch, source, new AbortController().signal);
  cleanup.push(() => lease?.release());
  expect(lease?.url).toContain("/_0media/video/");
  expect(worker.postMessage.mock.calls.map((call: any[]) => call[0].kind)).toEqual(["claim", "probe"]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(sw.getRegistration).toHaveBeenCalledWith(location.href);
});

it("still delivers one claim when registration lookup outlives the player's wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  sw.controller = null;
  let found!: (registration: any) => void;
  sw.getRegistration = vi.fn(() => new Promise(resolve => { found = resolve; }));
  worker.postMessage.mockImplementation(() => undefined);
  const fetch = vi.fn();
  const pending = bridge.progressiveVideo(fetch, source, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2001);
  expect(await pending).toBeUndefined();
  found({ active: worker });
  await Promise.resolve();
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ protocol: "0media-video-v1", kind: "claim" });
  expect(fetch).not.toHaveBeenCalled();
});

it("never sends a late claim for an aborted player", async () => {
  sw.controller = null;
  let found!: (registration: any) => void;
  sw.getRegistration = vi.fn(() => new Promise(resolve => { found = resolve; }));
  const abort = new AbortController();
  const pending = bridge.progressiveVideo(vi.fn(), source, abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  found({ active: worker }); await Promise.resolve();
  expect(worker.postMessage).not.toHaveBeenCalled();
});

it.each(["playing", "released", "closed", "aborted"])("separates late claim ownership from completed blob transport cleanup: %s", async state => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  sw.controller = null;
  let found!: (registration: any) => void;
  sw.getRegistration = vi.fn(() => new Promise(resolve => { found = resolve; }));
  worker.postMessage.mockImplementation(() => undefined);
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:offline"), revokeObjectURL: vi.fn() }));
  const { VideoLoader } = await import("../transport/media/video");
  let transportSignal!: AbortSignal;
  const fetch = vi.fn(async (_url: any, init: any) => {
    transportSignal = init.signal;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
  });
  const loader = new VideoLoader(fetch); cleanup.push(() => loader.close());
  loader.register("offline", source);
  const owner = new AbortController();
  const pending = loader.load("offline", owner.signal);
  await vi.advanceTimersByTimeAsync(2001);
  const lease = await pending;
  expect(lease.url).toBe("blob:offline");
  expect(transportSignal.aborted).toBe(true);
  if (state === "released") lease.release();
  if (state === "closed") loader.close();
  if (state === "aborted") owner.abort();
  found({ active: worker }); await Promise.resolve();
  expect(worker.postMessage).toHaveBeenCalledTimes(state === "playing" ? 1 : 0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});

it("does not accept an old same-URL worker's unversioned probe", async () => {
  worker.postMessage.mockImplementation((data: any, ports: any[]) => {
    ports[0].postMessage({ protocol: data.protocol, kind: "ready" }); ports[0].close();
  });
  const fetch = vi.fn();
  expect(await bridge.progressiveVideo(fetch, source, new AbortController().signal)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not publish a native URL or fetch CDN metadata when messages work but HTTP interception does not", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410, headers: { "cf-ray": "offline-edge" } })));
  const mediaFetch = vi.fn();
  expect(await bridge.progressiveVideo(mediaFetch, source, new AbortController().signal)).toBeUndefined();
  expect(mediaFetch).not.toHaveBeenCalled();
});

it("rechecks interception for each lease rather than reusing stale fetch evidence", async () => {
  const mediaFetch = vi.fn(async () => response());
  const first = await bridge.progressiveVideo(mediaFetch, source, new AbortController().signal);
  const second = await bridge.progressiveVideo(mediaFetch, source, new AbortController().signal);
  cleanup.push(() => { first?.release(); second?.release(); });
  expect(first).toBeDefined(); expect(second).toBeDefined();
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(mediaFetch).toHaveBeenCalledTimes(2);
});

it("stops a second lease if fetch bypass begins after a successful first lease", async () => {
  const mediaFetch = vi.fn(async () => response());
  const first = await bridge.progressiveVideo(mediaFetch, source, new AbortController().signal);
  cleanup.push(() => first?.release());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
  expect(await bridge.progressiveVideo(mediaFetch, source, new AbortController().signal)).toBeUndefined();
  expect(mediaFetch).toHaveBeenCalledOnce();
});

it("rechecks a missing registration when startup finishes during the bounded wait", async () => {
  sw.controller = null;
  sw.getRegistration = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ active: worker });
  const original = worker.postMessage.getMockImplementation();
  worker.postMessage.mockImplementation((data: any, ports: any[]) => {
    if (data.kind === "claim") { sw.controller = worker; sw.emit("controllerchange"); return; }
    return original(data, ports);
  });
  const fetch = vi.fn(async () => response());
  const pending = bridge.progressiveVideo(fetch, source, new AbortController().signal);
  await Promise.resolve();
  window.dispatchEvent(new Event("0media-worker-updated"));
  const lease = await pending;
  cleanup.push(() => lease?.release());
  expect(lease).toBeDefined();
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not start metadata after cancellation while waiting for worker control", async () => {
  sw.controller = null;
  sw.getRegistration = vi.fn(() => new Promise(() => {}));
  const controller = new AbortController();
  const fetch = vi.fn();
  const pending = bridge.progressiveVideo(fetch, source, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not publish a virtual URL when controller changes during the metadata request", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = bridge.progressiveVideo(fetch, source, new AbortController().signal).catch(error => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  sw.controller = { scriptURL: worker.scriptURL, postMessage: vi.fn() };
  sw.emit("controllerchange"); finish(response());
  const result = await pending;
  if (result?.release) cleanup.push(() => result.release());
  expect(result).not.toHaveProperty("url");
});

it("reclaims abandoned worker ports before they permanently exhaust the stream limit", async () => {
  const lease = await bridge.progressiveVideo(async () => response(), source, new AbortController().signal);
  cleanup.push(() => lease!.release());
  const token = new URL(lease!.url).pathname.split("/").at(-1);
  const open = () => {
    const ports = channel();
    const received = new Promise<any>(resolve => { ports.port1.once("message", resolve); });
    sw.emit("message", { source: worker, data: { protocol: "0media-video-v1", kind: "range", token,
      method: "GET", range: "bytes=0-99" }, ports: [ports.port2] });
    return { ports, received };
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (let i = 0; i < 4; i++) {
    const request = open();
    expect((await request.received).kind).toBe("headers");
    request.ports.port1.close(); // Lost worker process: no cancellation message.
  }
  await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
  const next = open();
  expect((await next.received).kind).toBe("headers");
});
