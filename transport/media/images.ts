import type { FetchLike } from "../types";
import { ProtocolError } from "../types";
import { assertAllowedTarget } from "../policy";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOWNLOADS = 4;
const MAX_PENDING = 128;
const TIMEOUT_MS = 20_000;
type PendingImage = { controller: AbortController; users: number; promise: Promise<string | undefined> };

/** Coalesced, owner-cancellable image work. Failed results never poison refresh.
 * Successful URLs live until explicit source release or client close. */
export class ImageLoader {
  private readonly cached = new Map<string, string>();
  private readonly urls = new Set<string>();
  private readonly pending = new Map<string, PendingImage>();
  private readonly waiting = new Set<() => void>();
  private active = 0;
  private closed = false;
  constructor(private readonly fetch: FetchLike) {}

  async load(source: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (this.closed) return;
    if (this.urls.has(source)) return source;
    const cached = this.cached.get(source);
    if (cached) return cached;
    let entry = this.pending.get(source);
    if (!entry || entry.controller.signal.aborted) {
      if (this.pending.size >= MAX_PENDING) throw new ProtocolError("Image preparation is busy. Retry this page when the current request finishes.");
      const controller = new AbortController();
      const created: PendingImage = { controller, users: 0, promise: Promise.resolve(undefined) };
      created.promise = this.download(source, controller).finally(() => {
        if (this.pending.get(source) === created) this.pending.delete(source);
      });
      this.pending.set(source, created);
      entry = created;
    }
    entry.users++;
    let stop: (() => void) | undefined;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        stop = () => reject(signal?.reason);
        signal?.addEventListener("abort", stop, { once: true });
        void entry!.promise.then(resolve, reject);
        if (signal?.aborted) stop();
      });
    } finally {
      if (stop) signal?.removeEventListener("abort", stop);
      if (--entry.users === 0) entry.controller.abort();
    }
  }

  private async slot(signal: AbortSignal): Promise<() => void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.waiting.delete(admit); signal.removeEventListener("abort", stop); };
      const stop = () => { cleanup(); reject(signal.reason); };
      const admit = () => {
        if (signal.aborted || this.closed) return stop();
        if (this.active >= MAX_DOWNLOADS) return;
        this.active++;
        cleanup();
        resolve();
      };
      this.waiting.add(admit);
      signal.addEventListener("abort", stop, { once: true });
      admit();
    });
    return () => { this.active--; for (const admit of [...this.waiting]) admit(); };
  }

  private async download(source: string, controller: AbortController): Promise<string | undefined> {
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => undefined); };
    try {
      assertAllowedTarget(new URL(source));
      release = await this.slot(signal);
      signal.throwIfAborted();
      // Local capacity waiting does not consume the network deadline.
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const pending = this.fetch(source, { credentials: "omit", redirect: "error", signal,
        headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.7" } });
      const response = await new Promise<Response>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        void pending.then(value => {
          signal.removeEventListener("abort", stop);
          if (signal.aborted) { void value.body?.cancel().catch(() => undefined); reject(signal.reason); }
          else resolve(value);
        }, error => { signal.removeEventListener("abort", stop); reject(error); });
        if (signal.aborted) stop();
      });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const declared = Number(response.headers.get("content-length"));
      if (!response.ok || !type?.startsWith("image/") || declared > MAX_IMAGE_BYTES || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      reader = response.body.getReader();
      signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) return;
        chunks.push(new Uint8Array(value));
      }
      if (!size || this.closed || signal.aborted) return;
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      this.urls.add(url);
      this.cached.set(source, url);
      return url;
    } catch { return; }
    finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      controller.abort();
      clearTimeout(timer);
      release?.();
    }
  }

  /** Remove every DOM reference to this source's blob before releasing it. */
  release(source: string): void {
    const pending = this.pending.get(source);
    if (pending) {
      pending.controller.abort();
      this.pending.delete(source);
    }
    const url = this.cached.get(source);
    if (url) {
      this.cached.delete(source);
      this.urls.delete(url);
      URL.revokeObjectURL(url);
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.controller.abort();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.cached.clear();
    this.urls.clear();
    this.pending.clear();
  }
}
