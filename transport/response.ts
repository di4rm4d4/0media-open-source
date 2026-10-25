import { waitForAbort } from "./abort";

/** Bound the consumed/decompressed response, not just Content-Length. */
export async function readResponseBytes(response: Response, maxBytes = 256 * 1024, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid response limit.");
  signal?.throwIfAborted();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const pending = reader.read();
      const { done, value } = await (signal ? waitForAbort(pending, signal) : pending);
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    // A source's asynchronous cancel hook may never settle. Cleanup must not
    // keep a cancelled request alive after its owner's deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
