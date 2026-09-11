import { ProtocolError, type FetchLike } from "../types";
import type { VideoLease } from "../types";
import { browserRange, readVideoRange, VIDEO_CHUNK_BYTES } from "./ranges";
import { WORKER_UPDATED_EVENT, videoWorkerIntercepts } from "./worker-lifecycle";

const PROTOCOL = "0media-video-v1";
const PREFIX = "/_0media/video/";
const leases = new Map<string, { url: string; open(event: MessageEvent): void; close(): void; invalidate(): void }>();
const workers = new WeakMap<ServiceWorker, Promise<boolean>>();
let listening = false;
let activeRanges = 0;
const queue = new Set<() => void>();

async function rangeSlot(signal: AbortSignal): Promise<() => void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { queue.delete(start); signal.removeEventListener("abort", stop); };
    const stop = () => { cleanup(); reject(signal.reason); };
    const start = () => { if (signal.aborted) return stop(); if (activeRanges >= 2) return;
      activeRanges++; cleanup(); resolve(); };
    queue.add(start); signal.addEventListener("abort", stop, { once: true }); start();
  });
  return () => { activeRanges--; for (const start of [...queue]) start(); };
}

export function ownsProgressiveVideo(url: string): boolean {
  for (const lease of leases.values()) if (lease.url === url) return true;
  return false;
}

async function videoController(signal: AbortSignal, claimSignal: AbortSignal): Promise<ServiceWorker | undefined> {
  if (!("serviceWorker" in navigator)) return;
  const service = navigator.serviceWorker;
  if (service.controller) return service.controller;
  if (!service.getRegistration) return;
  // A hard reload can bypass an already-active worker for this document.
  // Ask only our installed same-origin worker to claim it; never reload/login.
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => { clearTimeout(timer); service.removeEventListener("controllerchange", changed); signal.removeEventListener("abort", aborted); window.removeEventListener(WORKER_UPDATED_EVENT, lookup); };
    const finish = () => { if (done) return; done = true; cleanup(); resolve(service.controller ?? undefined); };
    const changed = () => finish();
    const aborted = () => { if (done) return; done = true; cleanup(); reject(signal.reason); };
    const timer = setTimeout(finish, 2000);
    service.addEventListener("controllerchange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    const claimed = new WeakSet<ServiceWorker>();
    function lookup() {
      void service.getRegistration(location.href).then(registration => {
        if (claimSignal.aborted || service.controller) return;
        const active = registration?.active;
        // A slow lookup may outlive this player's bounded wait. Still deliver
        // its one claim so subsequent players are not permanently uncontrolled.
        // Never publish a late URL or replace an already-playing blob here.
        if (active?.scriptURL === new URL("/sw.js", location.origin).href && !claimed.has(active)) {
          claimed.add(active); active.postMessage({ protocol: PROTOCOL, kind: "claim" });
        }
      }).catch(() => undefined);
    }
    window.addEventListener(WORKER_UPDATED_EVENT, lookup);
    lookup();
    if (signal.aborted) aborted();
  });
}

async function bridgeReady(signal: AbortSignal, claimSignal: AbortSignal): Promise<ServiceWorker | undefined> {
  const worker = await videoController(signal, claimSignal);
  if (!worker) return;
  if (worker.scriptURL !== new URL("/sw.js", location.origin).href) return;
  if (!listening) {
    listening = true;
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.source !== navigator.serviceWorker.controller || event.data?.protocol !== PROTOCOL
        || event.data?.kind !== "range" || typeof event.data?.token !== "string" || event.ports.length !== 1) return;
      const lease = leases.get(event.data.token);
      if (lease) lease.open(event);
      else { event.ports[0].postMessage({ kind: "error", status: 410 }); event.ports[0].close(); }
    });
    window.addEventListener("pagehide", () => { for (const lease of leases.values()) lease.invalidate(); });
    navigator.serviceWorker.addEventListener("controllerchange", () => { for (const lease of leases.values()) lease.invalidate(); });
  }
  let checked = workers.get(worker);
  if (!checked) {
    checked = new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = (ready: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(ready); };
      const timer = setTimeout(() => finish(false), 2000);
      channel.port1.onmessage = event => finish(event.data?.protocol === PROTOCOL && event.data?.kind === "ready" && event.data?.version === 3
        && navigator.serviceWorker.controller === worker);
      worker.postMessage({ protocol: PROTOCOL, kind: "probe" }, [channel.port2]);
    });
    workers.set(worker, checked);
  }
  const ready = await checked;
  if (!ready) { workers.delete(worker); return; }
  if (navigator.serviceWorker.controller !== worker) return;
  // Recheck per lease: message capability can outlive a page's fetch routing.
  if (!await videoWorkerIntercepts(signal)) return;
  if (navigator.serviceWorker.controller !== worker) return;
  return worker;
}

/** This page, not the worker, owns the TLS source and revocable video lease. */
export async function progressiveVideo(fetch: FetchLike, source: string, signal: AbortSignal, claimSignal = signal): Promise<VideoLease | undefined> {
  const worker = await bridgeReady(signal, claimSignal);
  if (!worker) return;
  signal.throwIfAborted();
  if (navigator.serviceWorker.controller !== worker) throw new ProtocolError("The video connection updated. Retry to open a new player.");
  const metadataSlot = await rangeSlot(signal);
  let metadata;
  try { metadata = (await readVideoRange(fetch, source, 0, 1, signal)).metadata; }
  finally { metadataSlot(); }
  signal.throwIfAborted();
  if (navigator.serviceWorker.controller !== worker) throw new ProtocolError("The video connection updated. Retry to open a new player.");
  const token = crypto.randomUUID();
  const url = new URL(PREFIX + token, location.origin).href;
  const streams = new Set<() => void>();
  let closed = false;
  let failure: ProtocolError | undefined;
  const invalidated = new Set<() => void>();
  const close = () => {
    if (closed) return;
    closed = true; leases.delete(token);
    for (const stop of [...streams]) stop();
    signal.removeEventListener("abort", close);
  };
  const owner = { url, close, invalidate() {
    failure = new ProtocolError("The video connection updated. Retry to open a new player.");
    close(); for (const listener of [...invalidated]) listener(); invalidated.clear();
  }, open(event: MessageEvent) {
    const port = event.ports[0];
    const input = event.data;
    if (closed || streams.size >= 4 || !["GET", "HEAD"].includes(input.method)
      || input.range !== null && (typeof input.range !== "string" || input.range.length > 80)) {
      port.postMessage({ kind: "error", status: 410 }); port.close(); return;
    }
    let requested;
    try { requested = browserRange(input.method === "HEAD" ? null : input.range, metadata.size); }
    catch { port.postMessage({ kind: "error", status: 416, size: metadata.size }); port.close(); return; }
    const controller = new AbortController();
    let busy = false;
    let cursor = requested.start;
    const stop = () => { clearTimeout(idleTimer); controller.abort(); streams.delete(stop); port.postMessage({ kind: "error", status: 410 }); port.close(); };
    let idleTimer = setTimeout(stop, 45_000);
    streams.add(stop);
    port.onmessage = async event => {
      clearTimeout(idleTimer); idleTimer = setTimeout(stop, 45_000);
      if (event.data?.kind === "keepalive") return;
      if (event.data?.kind === "cancel") { stop(); return; }
      if (event.data?.kind !== "pull" || busy || closed || controller.signal.aborted) { stop(); return; }
      busy = true;
      let release: (() => void) | undefined;
      try {
        release = await rangeSlot(controller.signal);
        const end = Math.min(requested.end, cursor + VIDEO_CHUNK_BYTES - 1);
        const result = await readVideoRange(fetch, source, cursor, end, controller.signal, metadata);
        controller.signal.throwIfAborted();
        cursor = end + 1;
        busy = false;
        port.postMessage({ kind: "chunk", bytes: result.bytes }, [result.bytes]);
        if (cursor > requested.end) { clearTimeout(idleTimer); streams.delete(stop); port.close(); }
      } catch (error) {
        if (!controller.signal.aborted) failure = error instanceof ProtocolError ? error : new ProtocolError("This video could not continue loading.");
        stop();
      } finally { release?.(); }
    };
    port.postMessage({ kind: "headers", status: requested.status, start: requested.start, end: requested.end,
      size: metadata.size, type: metadata.type });
    if (input.method === "HEAD") { clearTimeout(idleTimer); streams.delete(stop); port.close(); }
  } };
  leases.set(token, owner);
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  return { url, release: close, failure: () => failure,
    onInvalidated: listener => { invalidated.add(listener); return () => invalidated.delete(listener); } };
}
