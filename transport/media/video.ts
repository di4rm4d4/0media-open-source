import { ProtocolError, type FetchLike } from "../types";
import { retryAfterMs } from "../retry-after";
import type { VideoLease } from "../types";
import { assertAllowedTarget } from "../policy";
import { progressiveVideo } from "./video-bridge";
import { RangeUnsupportedError } from "./ranges";

export const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const MAX_DOWNLOADS = 2;
const DOWNLOAD_TIMEOUT_MS = 30_000;
class VideoSizeError extends ProtocolError {
  constructor() { super("This rendition is too large to download. Retry to use a smaller version if one was registered."); }
}
type VideoSource = { urls: string[]; next: number };

/** Bounded on-demand downloads through the existing WASM TLS session. No CDN
 * URL is ever assigned to a native media element, and no video survives close. */
export class VideoLoader {
  private readonly sources = new Map<string, VideoSource>();
  private readonly downloads = new Set<AbortController>();
  private readonly requests = new Set<AbortController>();
  private readonly waiting = new Set<() => void>();
  private readonly leases = new Set<VideoLease>();
  private closed = false;
  constructor(private readonly fetch: FetchLike) {}

  register(id: string, source: string, alternatives: string[] = []): void {
    const urls = [...new Set([source, ...alternatives.slice(0, 3)])].map(source => {
      const url = new URL(source);
      assertAllowedTarget(url);
      if (url.username || url.password) throw new ProtocolError("The upstream service returned an unsupported video address.");
      return url.toString();
    });
    const previous = this.sources.get(id);
    this.sources.delete(id);
    this.sources.set(id, previous && JSON.stringify(previous.urls) === JSON.stringify(urls) ? previous : { urls, next: 0 });
    if (this.sources.size > 200) this.sources.delete(this.sources.keys().next().value!);
  }

  private admit(controller: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
      const { signal } = controller;
      const cleanup = () => { this.waiting.delete(start); signal.removeEventListener("abort", stop); };
      const stop = () => { cleanup(); reject(signal.reason); };
      const start = () => {
        if (signal.aborted || this.closed) return stop();
        if (this.downloads.size + this.leases.size >= MAX_DOWNLOADS) return;
        this.downloads.add(controller); cleanup(); resolve();
      };
      this.waiting.add(start);
      signal.addEventListener("abort", stop, { once: true });
      start();
    });
  }

  private nextWaiting(): void { for (const start of [...this.waiting]) start(); }

  async load(id: string, signal?: AbortSignal): Promise<VideoLease> {
    signal?.throwIfAborted();
    const selection = this.sources.get(id);
    if (this.closed || !selection) throw new ProtocolError("This video is no longer available. Register its source again in an open loader.");
    const source = selection.urls[selection.next];
    if (this.requests.size >= 12) throw new ProtocolError("Too many video requests are waiting. Retry after releasing an active video.");
    const controller = new AbortController();
    // A completed blob's HTTP cleanup is not player/account cancellation.
    // Keep the one pending worker claim alive only until this lease is released.
    const claimOwner = new AbortController();
    const cancelClaim = () => claimOwner.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", cancelClaim, { once: true });
    const abort = () => { controller.abort(signal?.reason); claimOwner.abort(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.requests.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let progressive = false;
    let published = false;
    try {
      // Local capacity waiting is not a failed network operation. Navigation
      // cancels this queue entry; the network deadline begins after admission.
      await this.admit(controller);
      controller.signal.throwIfAborted();
      try {
        const streamed = await progressiveVideo(this.fetch, source, controller.signal, claimOwner.signal);
        if (streamed) {
          progressive = true;
          const lease: VideoLease = { url: streamed.url, failure: streamed.failure, onInvalidated: streamed.onInvalidated, release: () => {
            streamed.release(); controller.abort(); claimOwner.abort(); signal?.removeEventListener("abort", abort);
            if (this.leases.delete(lease)) this.nextWaiting();
          } };
          this.leases.add(lease);
          published = true;
          return lease;
        }
      } catch (error) {
        // A server that ignores a range can still use the bounded blob path.
        // No denial, rate limit, network failure or malformed 206 is retried.
        if (!(error instanceof RangeUnsupportedError)) throw error;
      }
      timer = setTimeout(() => controller.abort(new DOMException("Video download timed out.", "TimeoutError")), DOWNLOAD_TIMEOUT_MS);
      const pending = this.fetch(source, { credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { accept: "video/mp4,video/webm" } });
      const response = await new Promise<Response>((resolve, reject) => {
        const stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", stop, { once: true });
        void pending.then(value => {
          controller.signal.removeEventListener("abort", stop);
          if (controller.signal.aborted) { void value.body?.cancel().catch(() => undefined); reject(controller.signal.reason); }
          else resolve(value);
        }, cause => { controller.signal.removeEventListener("abort", stop); reject(cause); });
        if (controller.signal.aborted) stop();
      });
      controller.signal.throwIfAborted();
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const declared = Number(response.headers.get("content-length"));
      if (!response.ok || !["video/mp4", "video/webm"].includes(type ?? "") || declared > MAX_VIDEO_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        if (response.ok && declared > MAX_VIDEO_BYTES) throw new VideoSizeError();
        throw new ProtocolError(response.status === 429 ? "The upstream service temporarily limited video requests."
          : "The upstream service did not return a supported video.", response.status, retryAfterMs(response.headers));
      }
      if (!response.body) throw new ProtocolError("The upstream service returned an empty video.");
      reader = response.body.getReader();
      // Cancel a stalled reader too, including transports that ignore fetch's signal.
      const cancel = () => { void reader?.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_VIDEO_BYTES) throw new VideoSizeError();
          chunks.push(new Uint8Array(value));
        }
      } finally { controller.signal.removeEventListener("abort", cancel); }
      if (!size || this.closed) throw new ProtocolError("The video download did not complete.");
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const lease: VideoLease = { url, release: () => {
        claimOwner.abort(); signal?.removeEventListener("abort", abort);
        if (this.leases.delete(lease)) { URL.revokeObjectURL(url); this.nextWaiting(); }
      } };
      this.leases.add(lease);
      published = true;
      return lease;
    } catch (cause) {
      if (cause instanceof VideoSizeError && this.sources.get(id) === selection) selection.next = Math.min(selection.next + 1, selection.urls.length - 1);
      if (cause instanceof ProtocolError || signal?.aborted) throw cause;
      throw new ProtocolError(controller.signal.aborted ? "This video download timed out. Try again when ready." : "The encrypted video download did not finish.");
    } finally {
      // libcurl.js stream cancellation alone does not immediately tear down its
      // HTTP handle. Abort the owned request before admitting another download.
      if (!progressive) {
        if (published) controller.signal.removeEventListener("abort", cancelClaim);
        controller.abort();
      }
      clearTimeout(timer);
      if (!published) { claimOwner.abort(); signal?.removeEventListener("abort", abort); }
      void reader?.cancel().catch(() => undefined);
      this.downloads.delete(controller);
      this.requests.delete(controller);
      this.nextWaiting();
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    for (const lease of this.leases) lease.release();
    this.sources.clear();
  }
}
