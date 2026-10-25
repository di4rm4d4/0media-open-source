import { ProtocolError, type FetchLike } from "../types";
import { retryAfterMs } from "../retry-after";
import { assertAllowedTarget } from "../policy";
import { waitForAbort } from "../abort";

export const VIDEO_CHUNK_BYTES = 1024 * 1024;
export const MAX_PROGRESSIVE_VIDEO_BYTES = 512 * 1024 * 1024;
export class RangeUnsupportedError extends ProtocolError {}
export interface VideoMetadata { size: number; type: string; etag: string | null; modified: string | null }

export function browserRange(value: string | null, size: number): { start: number; end: number; status: 200 | 206 } {
  if (value === null) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(value);
  if (!match || !match[1] && !match[2]) throw new ProtocolError("Unsupported video range.", 416);
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || suffix && Number(match[2]) === 0) {
    throw new ProtocolError("Unsupported video range.", 416);
  }
  return { start, end, status: 206 };
}

/** Read exactly one bounded identity-encoded range. The URL stays in this page's
 * WASM transport; neither the service worker nor the native video receives it. */
export async function readVideoRange(fetch: FetchLike, source: string, start: number, end: number,
  signal: AbortSignal, expected?: VideoMetadata): Promise<{ bytes: ArrayBuffer; metadata: VideoMetadata }> {
  assertAllowedTarget(new URL(source));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > VIDEO_CHUNK_BYTES) throw new ProtocolError("Unsupported video range.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    signal.throwIfAborted();
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    let offset = 0;
    let pinned = expected;
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted();
      const request = new AbortController();
      const stopRequest = () => request.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", stopRequest, { once: true });
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel().catch(() => undefined); };
      try {
        const requestStart = start + offset;
        const requestEnd = bytes ? start + bytes.byteLength - 1 : end;
        const headers: Record<string, string> = { accept: "video/mp4,video/webm", "accept-encoding": "identity", range: `bytes=${requestStart}-${requestEnd}` };
        if (pinned?.etag && !pinned.etag.startsWith("W/")) headers["if-range"] = pinned.etag;
        else if (pinned?.modified) headers["if-range"] = pinned.modified;
        response = await waitForAbort(fetch(source, {
          headers, credentials: "omit", redirect: "error", signal: request.signal,
        }), request.signal, late => { void late.body?.cancel().catch(() => undefined); });
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const match = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/.exec(response.headers.get("content-range") ?? "");
        const total = match ? Number(match[3]) : 0;
        const encoding = response.headers.get("content-encoding");
        if (response.status !== 206 || !match || Number(match[1]) !== requestStart || Number(match[2]) !== Math.min(requestEnd, total - 1)
          || !Number.isSafeInteger(total) || total <= requestStart || total > MAX_PROGRESSIVE_VIDEO_BYTES
          || !["video/mp4", "video/webm"].includes(type ?? "") || encoding && encoding !== "identity") {
          if (!pinned && response.status === 200 && ["video/mp4", "video/webm"].includes(type ?? "")) throw new RangeUnsupportedError("This video does not support progressive requests.");
          throw new ProtocolError("The upstream service did not return the requested video range.", response.status, retryAfterMs(response.headers));
        }
        const metadata: VideoMetadata = { size: total, type: type!, etag: response.headers.get("etag"), modified: response.headers.get("last-modified") };
        const length = Math.min(requestEnd, total - 1) - requestStart + 1;
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) !== length || pinned && (pinned.size !== total || pinned.type !== type
          || pinned.etag !== metadata.etag || pinned.modified !== metadata.modified) || (metadata.etag?.length ?? 0) > 256 || (metadata.modified?.length ?? 0) > 128) {
          throw new ProtocolError("The video changed while loading. Retry to open a new player.");
        }
        if (!response.body) throw new ProtocolError("The upstream service returned an empty video range.");
        pinned = metadata;
        bytes ??= new Uint8Array(length);
        reader = response.body.getReader();
        request.signal.addEventListener("abort", cancel, { once: true });
        while (true) {
          request.signal.throwIfAborted();
          const { done, value } = await waitForAbort(reader.read(), request.signal);
          request.signal.throwIfAborted();
          if (done) break;
          if (offset + value.byteLength > bytes.byteLength) throw new ProtocolError("The upstream service returned an oversized video range.");
          bytes.set(value, offset);
          offset += value.byteLength;
        }
        if (offset === bytes.byteLength) return { bytes: bytes.buffer, metadata };
        // One clean-EOF repair with a strong ETag. Keep the accepted prefix,
        // pin the representation, and request only its missing tail. Both
        // attempts share the original deadline and one bounded allocation.
        if (attempt || !offset || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(metadata.etag ?? "")) {
          throw new ProtocolError("The video range did not finish loading.");
        }
      } finally {
        request.signal.removeEventListener("abort", cancel);
        cancel();
        if (reader) reader.releaseLock();
        else void response?.body?.cancel().catch(() => undefined);
        request.abort();
        controller.signal.removeEventListener("abort", stopRequest);
      }
    }
    throw new ProtocolError("The video range did not finish loading.");
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("The encrypted video range could not load.");
  } finally {
    controller.abort(); clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
