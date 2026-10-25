import { afterEach, expect, it, vi } from "vitest";
import { requestBytes, requestJson, requestText } from "../transport/request";
import type { HttpRequestOptions } from "../transport/request";

const url = "https://example.com/";
const json = (body = '{"items":[]}', type = "application/json") => new Response(body, { headers: { "content-type": type } });
afterEach(() => vi.useRealTimers());

it("reads bytes and releases the HTTP owner after consuming the complete body", async () => {
  const fetch = vi.fn(async (_input, init) => {
    expect(init.signal.aborted).toBe(false);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  expect([...await requestBytes(fetch, url)]).toEqual([1, 2, 3]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it("decodes UTF-8 text and preserves explicit request headers, body and cookie mode", async () => {
  const fetch = vi.fn(async () => new Response("café"));
  expect(await requestText(fetch, url, {
    method: "POST", body: "input", headers: { "x-example": "value" }, credentials: "include",
  })).toBe("café");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
    method: "POST", body: "input", headers: { "x-example": "value" }, credentials: "include",
  }));
});

it.each(["application/json", "application/problem+json", "application/vnd.example~format+json", "Application/JSON; charset=utf-8"])("parses bounded %s", async type => {
  expect(await requestJson(async () => json('{"value":42}', type), url)).toEqual({ value: 42 });
});

it.each([
  () => json("<html>login</html>", "text/html"),
  () => json("{broken}"),
  () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
  () => new Response(null, { status: 204 }),
])("rejects login HTML, malformed JSON, invalid UTF-8 and an empty JSON response", async response => {
  await expect(requestJson(async () => response(), url)).rejects.toMatchObject({ name: "ProtocolError" });
});

it.each([301, 401, 403, 429, 503])("reports HTTP %s without retries or an untrusted error body", async status => {
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
    status, headers: { "retry-after": "12" },
  }));
  await expect(requestText(fetch, url, { method: "POST", body: "write" })).rejects.toMatchObject({
    name: "ProtocolError", status, retryAfterMs: 12_000, message: `Request failed (HTTP ${status}).`,
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it("uses the response clock for a Retry-After date rather than the caller's clock", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 503, headers: {
    date: "Sun, 25 Oct 2026 12:00:00 GMT",
    "retry-after": "Sun, 25 Oct 2026 12:00:30 GMT",
  } }));
  await expect(requestText(fetch, url)).rejects.toMatchObject({ status: 503, retryAfterMs: 30_000 });
  expect(fetch).toHaveBeenCalledOnce();
});

it("enforces actual bytes even when Content-Length claims a small response", async () => {
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel,
  }), { headers: { "content-length": "1" } }));
  await expect(requestBytes(fetch, url, { maxBytes: 8 })).rejects.toThrow(/limit/);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 },
  { maxBytes: 0 }, { maxBytes: NaN }, { maxBytes: 1.5 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
])("rejects invalid limits before dispatch: %j", async options => {
  const fetch = vi.fn();
  await expect(requestBytes(fetch, url, options)).rejects.toBeInstanceOf(RangeError);
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels stalled initialization/headers at the deadline and discards a late response", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetch = vi.fn((_input, _init) => new Promise<Response>(resolve => { finish = resolve; }));
  const result = requestBytes(fetch, url, { timeoutMs: 100 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ name: "TimeoutError" });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  const cancel = vi.fn();
  finish(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
});

it("applies the same deadline while the response body is stalled", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const result = requestBytes(async () => new Response(new ReadableStream({ cancel })), url, { timeoutMs: 100 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ name: "TimeoutError" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves an external abort reason without aborting the caller's signal on success", async () => {
  const owner = new AbortController();
  expect(await requestText(async () => new Response("ok"), url, { signal: owner.signal })).toBe("ok");
  expect(owner.signal.aborted).toBe(false);
  const pending = requestText(() => new Promise(() => {}), url, { signal: owner.signal }).catch(error => error);
  const reason = new Error("navigation");
  owner.abort(reason);
  expect(await pending).toBe(reason);
});

it("inherits a Request's cancellation unless the caller explicitly replaces it", async () => {
  const owner = new AbortController();
  const input = new Request(url, { signal: owner.signal });
  owner.abort();
  const fetch = vi.fn(async () => new Response("ok"));
  await expect(requestText(fetch, input)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect(await requestText(fetch, input, { signal: null })).toBe("ok");
});

it("cleans timers and listeners after a synchronous transport exception", async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const remove = vi.spyOn(owner.signal, "removeEventListener");
  const fetch = () => { throw new Error("offline"); };
  await expect(requestBytes(fetch, url, { signal: owner.signal } satisfies HttpRequestOptions)).rejects.toThrow("offline");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
