// Execute the actual worker listener with synthetic clients and native Node ports.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserRange, readVideoRange, VIDEO_CHUNK_BYTES, RangeUnsupportedError } from "../transport/media/ranges";

const workerCode = readFileSync(resolve("public/video-sw.js"), "utf8");
const token = "11111111-1111-4111-8111-111111111111";
const virtual = new URL("/_0media/video/" + token, location.origin).href;
const source = "https://example.com/offline.mp4";
const cleanup: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("MessageChannel", class extends NodeMessageChannel {
  constructor() { super(); cleanup.push(() => { this.port1.close(); this.port2.close(); }); }
}));
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

function worker(owner: (data: any, port: any) => void) {
  const listeners = new Map<string, (event: any) => void>();
  const client = { url: location.href, postMessage: vi.fn((data, ports) => owner(data, ports[0])) };
  const foreign = { url: location.href, postMessage: vi.fn((_data, ports) => {
    ports[0].postMessage({ kind: "error", status: 410 }); ports[0].close();
  }) };
  const get = vi.fn(async (id: string) => id === "owner" ? client : id === "foreign" ? foreign : undefined);
  const self = { location, clients: { get }, addEventListener: (kind: string, listener: (event: any) => void) => listeners.set(kind, listener) };
  // Native Node ports deserialize buffers in Node's realm, not jsdom's realm.
  new Function("self", "ArrayBuffer", workerCode)(self, Buffer.alloc(0).buffer.constructor);
  function dispatch(url = virtual, init: RequestInit = {}, clientId = "owner") {
    let response!: Promise<Response>, lifetime = Promise.resolve();
    const event = { request: new Request(url, init), clientId, stopImmediatePropagation: vi.fn(),
      respondWith: (value: Response | Promise<Response>) => { response = Promise.resolve(value); },
      waitUntil: (value: Promise<void>) => { lifetime = value; },
    };
    listeners.get("fetch")!(event);
    return { response, lifetime, event };
  }
  return { dispatch, get, client, foreign };
}

it("serves exact byte ranges, applies backpressure, and completes the worker event", async () => {
  let pulls = 0;
  const size = VIDEO_CHUNK_BYTES * 2 + 17;
  const harness = worker((data, port) => {
    expect(data).toMatchObject({ protocol: "0media-video-v1", kind: "range", token, range: "bytes=2-", method: "GET" });
    let cursor = 2;
    port.onmessage = (event: any) => {
      if (event.data.kind !== "pull") return;
      pulls++;
      const length = Math.min(VIDEO_CHUNK_BYTES, size - cursor);
      const bytes = Uint8Array.from({ length }, (_, i) => (cursor + i) % 251).buffer;
      cursor += length; port.postMessage({ kind: "chunk", bytes }, [bytes]);
    };
    port.postMessage({ kind: "headers", status: 206, type: "video/mp4", size, start: 2, end: size - 1 });
  });
  const event = harness.dispatch(virtual, { headers: { range: "bytes=2-" } });
  const response = await event.response;
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes 2-${size - 1}/${size}`);
  expect(response.headers.get("content-length")).toBe(String(size - 2));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(pulls).toBe(0);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.value?.length).toBe(VIDEO_CHUNK_BYTES);
  expect(first.value?.[0]).toBe(2);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(pulls).toBe(1);
  let read = first.value!.length;
  while (true) { const next = await reader.read(); if (next.done) break; read += next.value.length; }
  expect(read).toBe(size - 2); expect(pulls).toBe(3);
  await event.lifetime;
  expect(event.event.stopImmediatePropagation).toHaveBeenCalledOnce();
});

it("returns HEAD metadata without a body or any pull and closes event lifetime", async () => {
  const kinds: string[] = [];
  const harness = worker((data, port) => {
    expect(data.method).toBe("HEAD");
    port.onmessage = (event: any) => kinds.push(event.data.kind);
    port.postMessage({ kind: "headers", status: 200, type: "video/mp4", size: 100, start: 0, end: 99 });
  });
  const event = harness.dispatch(virtual, { method: "HEAD", headers: { range: "bytes=2-4" } });
  const response = await event.response; await event.lifetime;
  expect(response.status).toBe(200); expect(response.body).toBeNull();
  expect(response.headers.get("content-length")).toBe("100");
  expect(response.headers.has("content-range")).toBe(false);
  expect(kinds).not.toContain("pull");
});

it("sends only to the requesting client and fails closed for another tab or invalid reserved URL", async () => {
  const harness = worker(() => { throw new Error("Foreign request reached owner"); });
  expect((await harness.dispatch(virtual, {}, "foreign").response).status).toBe(410);
  expect(harness.client.postMessage).not.toHaveBeenCalled();
  expect(harness.get).toHaveBeenCalledWith("foreign");
  for (const [url, method, id] of [
    [virtual + "?signed=offline", "GET", "owner"],
    [new URL("/_0media/video/invalid", location.origin).href, "GET", "owner"],
    [virtual, "POST", "owner"], [virtual, "GET", ""],
  ]) {
    const event = harness.dispatch(url, { method }, id);
    const response = await event.response;
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-0media-video-bridge")).toBe("3");
    expect(event.event.stopImmediatePropagation).toHaveBeenCalledOnce();
  }
  expect(harness.get).toHaveBeenCalledTimes(1);
});

it("cancels a pending worker pull when the native request aborts", async () => {
  let cancelSeen = false;
  let pullSeen = false;
  const harness = worker((_data, port) => {
    port.onmessage = (event: any) => {
      if (event.data.kind === "pull") pullSeen = true;
      if (event.data.kind === "cancel") cancelSeen = true;
    };
    port.postMessage({ kind: "headers", status: 200, type: "video/mp4", size: 100, start: 0, end: 99 });
  });
  const abort = new AbortController();
  const event = harness.dispatch(virtual, { signal: abort.signal });
  const reader = (await event.response).body!.getReader();
  const read = reader.read().catch(error => error);
  await vi.waitFor(() => expect(pullSeen).toBe(true));
  abort.abort();
  expect(await read).toBeInstanceOf(Error);
  await event.lifetime;
  await vi.waitFor(() => expect(cancelSeen).toBe(true));
});

it("parses full, tiny, tail, suffix and unsatisfiable browser ranges", () => {
  expect(browserRange(null, 100)).toEqual({ start: 0, end: 99, status: 200 });
  expect(browserRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1, status: 206 });
  expect(browserRange("bytes=99-", 100)).toEqual({ start: 99, end: 99, status: 206 });
  expect(browserRange("bytes=-7", 100)).toEqual({ start: 93, end: 99, status: 206 });
  expect(browserRange("bytes=0-999", 100)).toEqual({ start: 0, end: 99, status: 206 });
  for (const range of ["bytes=100-", "bytes=-0", "bytes=9-2", "bytes=", "bytes=1-2,3-4"]) {
    expect(() => browserRange(range, 100)).toThrow();
  }
});

it("bounds the CDN range and rejects changed, oversized, truncated and encoded representations", async () => {
  const expected = { size: 100, type: "video/mp4", etag: '"stable"', modified: null };
  const headers = { "content-type": "video/mp4", "content-range": "bytes 5-7/100", "content-length": "3", etag: '"stable"' };
  const fetch = vi.fn(async () => new Response(new Uint8Array([5, 6, 7]), { status: 206, headers }));
  const result = await readVideoRange(fetch, source, 5, 7, new AbortController().signal, expected);
  expect([...new Uint8Array(result.bytes)]).toEqual([5, 6, 7]);
  expect(fetch).toHaveBeenCalledWith(source, expect.objectContaining({ credentials: "omit", redirect: "error",
    headers: expect.objectContaining({ range: "bytes=5-7", "accept-encoding": "identity", "if-range": '"stable"' }) }));
  const bad = [
    new Response(new Uint8Array([5, 6]), { status: 206, headers }),
    new Response(new Uint8Array([5, 6, 7, 8]), { status: 206, headers }),
    new Response(new Uint8Array([5, 6, 7]), { status: 206, headers: { ...headers, etag: '"changed"' } }),
    new Response(new Uint8Array([5, 6, 7]), { status: 206, headers: { ...headers, "content-encoding": "gzip" } }),
    new Response(new Uint8Array([5, 6, 7]), { status: 206, headers: { ...headers, "content-range": "bytes 6-8/100" } }),
  ];
  for (const response of bad) await expect(readVideoRange(async () => response, source, 5, 7, new AbortController().signal, expected)).rejects.toThrow();
  await expect(readVideoRange(async () => new Response("", { headers: { "content-type": "video/mp4" } }), source, 0, 1, new AbortController().signal)).rejects.toBeInstanceOf(RangeUnsupportedError);
});

it("settles a stalled range read promptly and aborts its owned HTTP handle", async () => {
  let reading = false, canceled = false;
  let transportSignal: AbortSignal | null | undefined;
  const abort = new AbortController();
  const pending = readVideoRange(async (_input, init) => {
    transportSignal = init?.signal;
    return new Response(new ReadableStream({ pull() { reading = true; }, cancel() { canceled = true; } }), {
      status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-1/100", "content-length": "2" },
    });
  }, source, 0, 1, abort.signal).catch(error => error);
  await vi.waitFor(() => expect(reading).toBe(true));
  abort.abort();
  expect((await pending).name).toBe("AbortError");
  expect(canceled).toBe(true); expect(transportSignal?.aborted).toBe(true);
});
