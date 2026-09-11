import { ProtocolError, type FetchLike } from "../types";
import { retryAfterMs } from "../retry-after";
import { assertAllowedTarget } from "../policy";

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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => undefined); };
  try {
    signal.throwIfAborted();
    const headers: Record<string, string> = { accept: "video/mp4,video/webm", "accept-encoding": "identity", range: `bytes=${start}-${end}` };
    if (expected?.etag && !expected.etag.startsWith("W/")) headers["if-range"] = expected.etag;
    else if (expected?.modified) headers["if-range"] = expected.modified;
    const pending = fetch(source, { headers, credentials: "omit", redirect: "error", signal: controller.signal });
    const response = await new Promise<Response>((resolve, reject) => {
      const stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
      void pending.then(response => {
        controller.signal.removeEventListener("abort", stop);
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); reject(controller.signal.reason); }
        else resolve(response);
      }, error => { controller.signal.removeEventListener("abort", stop); reject(error); });
      if (controller.signal.aborted) stop();
    });
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const match = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/.exec(response.headers.get("content-range") ?? "");
    const total = match ? Number(match[3]) : 0;
    const encoding = response.headers.get("content-encoding");
    if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, total - 1)
      || !Number.isSafeInteger(total) || total <= start || total > MAX_PROGRESSIVE_VIDEO_BYTES
      || !["video/mp4", "video/webm"].includes(type ?? "") || encoding && encoding !== "identity") {
      void response.body?.cancel().catch(() => undefined);
      if (!expected && response.status === 200 && ["video/mp4", "video/webm"].includes(type ?? "")) throw new RangeUnsupportedError("This video does not support progressive requests.");
      throw new ProtocolError("The upstream service did not return the requested video range.", response.status, retryAfterMs(response.headers));
    }
    const metadata: VideoMetadata = { size: total, type: type!, etag: response.headers.get("etag"), modified: response.headers.get("last-modified") };
    const length = Math.min(end, total - 1) - start + 1;
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== length || expected && (expected.size !== total || expected.type !== type
      || expected.etag !== metadata.etag || expected.modified !== metadata.modified) || (metadata.etag?.length ?? 0) > 256 || (metadata.modified?.length ?? 0) > 128) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProtocolError("The video changed while loading. Retry to open a new player.");
    }
    if (!response.body) throw new ProtocolError("The upstream service returned an empty video range.");
    reader = response.body.getReader();
    controller.signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (offset + value.byteLength > length) throw new ProtocolError("The upstream service returned an oversized video range.");
      bytes.set(value, offset); offset += value.byteLength;
    }
    if (offset !== length) throw new ProtocolError("The video range did not finish loading.");
    return { bytes: bytes.buffer, metadata };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("The encrypted video range could not load.");
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    cancel(); controller.abort(); clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
