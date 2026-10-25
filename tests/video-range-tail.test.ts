import { afterEach, expect, it, vi } from "vitest";
import { readVideoRange } from "../transport/media/ranges";

const source = "https://example.com/video.mp4";
function range(start: number, end: number, body: number[], etag = '"original"', size = 200) {
  return new Response(new Uint8Array(body), { status: 206, headers: {
    "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}`,
    "content-length": String(end - start + 1), etag,
  } });
}
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

it("repairs only a missing tail, keeping the prefix and pinning the same strong ETag", async () => {
  const fetch = vi.fn((_url, _init) => Promise.resolve(range(100, 107, [1, 2, 3, 4, 5])))
    .mockResolvedValueOnce(range(100, 107, [1, 2, 3, 4, 5]))
    .mockResolvedValueOnce(range(105, 107, [6, 7, 8]));
  const result = await readVideoRange(fetch, source, 100, 107, signal());
  expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(result.metadata).toMatchObject({ size: 200, etag: '"original"' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetch.mock.calls[1][1]).toMatchObject({
    credentials: "omit", redirect: "error", headers: { range: "bytes=105-107", "if-range": '"original"' },
  });
});

it.each(['W/"weak"', "missing-quotes", '"bad\"quote"', ""])("does not repair without a valid strong ETag: %s", async etag => {
  const fetch = vi.fn(async () => range(0, 3, [1, 2], etag));
  await expect(readVideoRange(fetch, source, 0, 3, signal())).rejects.toThrow(/did not finish/);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not retry an empty prefix or a stream error", async () => {
  const empty = vi.fn(async () => range(0, 3, []));
  await expect(readVideoRange(empty, source, 0, 3, signal())).rejects.toThrow(/did not finish/);
  expect(empty).toHaveBeenCalledOnce();
  const broken = vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("network lost")); },
  }), { status: 206, headers: range(0, 3, []).headers }));
  await expect(readVideoRange(broken, source, 0, 3, signal())).rejects.toThrow(/could not load/);
  expect(broken).toHaveBeenCalledOnce();
});

it("stops after one tail repair rather than looping over partial responses", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(range(0, 3, [1]))
    .mockResolvedValueOnce(range(1, 3, [2]));
  await expect(readVideoRange(fetch, source, 0, 3, signal())).rejects.toThrow(/did not finish/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  () => range(2, 3, [3, 4], '"changed"'),
  () => range(2, 3, [3, 4], '"original"', 201),
  () => new Response(new Uint8Array([3, 4]), { headers: { "content-type": "video/mp4" } }),
])("rejects a changed representation or ignored If-Range during repair", async tail => {
  const fetch = vi.fn().mockResolvedValueOnce(range(0, 3, [1, 2])).mockResolvedValueOnce(tail());
  await expect(readVideoRange(fetch, source, 0, 3, signal())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("preserves a tail rate limit without another attempt", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(range(0, 3, [1, 2]))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "15" } }));
  await expect(readVideoRange(fetch, source, 0, 3, signal())).rejects.toMatchObject({ status: 429, retryAfterMs: 15_000 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps the original deadline across both requests and cancels a late tail", async () => {
  vi.useFakeTimers();
  let finishPrefix!: (response: Response) => void;
  let finishTail!: (response: Response) => void;
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finishPrefix = resolve; }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finishTail = resolve; }));
  const result = readVideoRange(fetch, source, 0, 3, signal()).catch(error => error);
  await vi.advanceTimersByTimeAsync(19_000);
  finishPrefix(range(0, 3, [1, 2]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject({ name: "ProtocolError" });
  const cancel = vi.fn();
  finishTail(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
});
