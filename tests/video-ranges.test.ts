import { beforeEach, expect, it, vi } from "vitest";
import { browserRange, readVideoRange, VIDEO_CHUNK_BYTES, MAX_PROGRESSIVE_VIDEO_BYTES } from "../transport/media/ranges";
const source = "https://example.com/offline.mp4";
const signal = () => new AbortController().signal;
const metadata = { size: 100, type: "video/mp4", etag: '"offline"', modified: null };
function response(bytes: Uint8Array = new Uint8Array(2), overrides: Record<string, string | undefined> = {}) {
  const headers: Record<string, string> = { "content-type": "video/mp4", "content-range": "bytes 0-1/100", etag: '"offline"' };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) headers[key] = value;
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 206, headers });
}
beforeEach(() => vi.restoreAllMocks());
it.each([
  [null, 0, 99, 200], ["bytes=0-1", 0, 1, 206], ["bytes=20-", 20, 99, 206],
  ["bytes=-10", 90, 99, 206], ["bytes=-200", 0, 99, 206], ["bytes=90-200", 90, 99, 206],
] as const)("supports native range %s", (value, start, end, status) => {
  expect(browserRange(value, 100)).toEqual({ start, end, status });
});
it.each(["bytes=", "bytes=-", "bytes=-0", "bytes=100-", "bytes=5-3", "bytes=0-1,5-8", "items=0-1", "bytes=99999999999999999-"])("rejects invalid range %s", value => {
  expect(() => browserRange(value, 100)).toThrow();
});
it("uses small native probes and exact bounded ranges without direct browser fetch", async () => {
  const native = vi.spyOn(globalThis, "fetch");
  const fetch = vi.fn(async () => response());
  const result = await readVideoRange(fetch, source, 0, 1, signal());
  expect(result.bytes.byteLength).toBe(2);
  expect(result.metadata).toEqual(metadata);
  expect(fetch).toHaveBeenCalledWith(source, expect.objectContaining({ credentials: "omit", redirect: "error",
    headers: expect.objectContaining({ range: "bytes=0-1", "accept-encoding": "identity" }) }));
  expect(native).not.toHaveBeenCalled();
});
it("permits a large file while buffering at most the requested chunk", async () => {
  const total = 90 * 1024 * 1024;
  const fetch = vi.fn(async () => response(new Uint8Array(VIDEO_CHUNK_BYTES), { "content-range": `bytes 0-${VIDEO_CHUNK_BYTES - 1}/${total}` }));
  const result = await readVideoRange(fetch, source, 0, VIDEO_CHUNK_BYTES - 1, signal());
  expect(result.metadata.size).toBe(total);
  expect(result.bytes.byteLength).toBe(VIDEO_CHUNK_BYTES);
});
it.each([
  { "content-range": "bytes 1-2/100" }, { "content-range": "bytes 0-1/*" },
  { "content-range": `bytes 0-1/${MAX_PROGRESSIVE_VIDEO_BYTES + 1}` },
  { "content-type": "text/html" }, { "content-encoding": "gzip" }, { "content-length": "100" },
])("rejects malformed range metadata before consuming media", async overrides => {
  await expect(readVideoRange(async () => response(new Uint8Array(2), overrides), source, 0, 1, signal())).rejects.toThrow();
});
it("cancels ignored Range without reading an unbounded 200", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ cancel });
  await expect(readVideoRange(async () => new Response(stream, { headers: { "content-type": "video/mp4" } }), source, 0, 1, signal())).rejects.toThrow(/progressive/);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([new Uint8Array(1), new Uint8Array(3)])("rejects truncated/oversized returned bytes", async bytes => {
  await expect(readVideoRange(async () => response(bytes), source, 0, 1, signal())).rejects.toThrow();
});
it.each([{ etag: '"changed"' }, { "content-range": "bytes 0-1/101" }, { "content-type": "video/webm" }, { "last-modified": "yesterday" }])("pins the representation across requests", async overrides => {
  await expect(readVideoRange(async () => response(new Uint8Array(2), overrides), source, 0, 1, signal(), metadata)).rejects.toThrow(/changed/);
});
it("preserves 429 and never retries or returns a private transport error", async () => {
  const limited = vi.fn(async () => new Response("private", { status: 429, headers: { "retry-after": "30" } }));
  await expect(readVideoRange(limited, source, 0, 1, signal())).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  expect(limited).toHaveBeenCalledOnce();
  await expect(readVideoRange(async () => { throw new Error("private-cdn-url"); }, source, 0, 1, signal())).rejects.toThrow("The encrypted video range could not load.");
});
it("aborts a stalled body and cancels an uncooperative late response", async () => {
  const controller = new AbortController(); let finish!: (response: Response) => void;
  const promise = readVideoRange(() => new Promise(resolve => { finish = resolve; }), source, 0, 1, controller.signal).catch(error => error);
  controller.abort();
  expect((await promise).name).toBe("AbortError");
  const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel })));
  await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
});
