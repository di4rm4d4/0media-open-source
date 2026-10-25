import { expect, it, vi } from "vitest";
import { itemPages } from "../examples/pagination";

const endpoint = "https://example.com/items?limit=20";
const page = (items: unknown[] = [], nextCursor: unknown = null) => new Response(JSON.stringify({ items, nextCursor }), {
  headers: { "content-type": "application/json" },
});

it("runs the pagination example with bounded requests and retains the original endpoint", async () => {
  const fetch = vi.fn((_input, _init) => Promise.resolve(page()))
    .mockResolvedValueOnce(page([{ id: "one", title: "First", ignored: "field" }], "page two"))
    .mockResolvedValueOnce(page([{ id: "two", title: "Second" }]));
  const pages = [];
  for await (const items of itemPages(fetch, endpoint)) pages.push(items);
  expect(pages).toEqual([[{ id: "one", title: "First" }], [{ id: "two", title: "Second" }]]);
  expect(String(fetch.mock.calls[1][0])).toBe("https://example.com/items?limit=20&cursor=page+two");
  expect(fetch.mock.calls.every(([, init]) => init.signal.aborted && init.credentials === "omit")).toBe(true);
});

it("does not prefetch when the consumer stops after one page", async () => {
  const fetch = vi.fn(async () => page([], "more"));
  for await (const _items of itemPages(fetch, endpoint)) break;
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  () => page([{ id: 42, title: "Wrong ID" }]),
  () => page([], { foreign: "cursor" }),
  () => page([], ""),
  () => page(Array.from({ length: 101 }, () => ({ id: "one", title: "Too many" }))),
])("rejects malformed service data before yielding it", async response => {
  await expect(itemPages(async () => response(), endpoint).next()).rejects.toMatchObject({ name: "ProtocolError" });
});

it("reports a failed continuation without presenting it as end of results", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(page([{ id: "one", title: "First" }], "more"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const pages = itemPages(fetch, endpoint);
  expect(await pages.next()).toMatchObject({ done: false, value: [{ id: "one", title: "First" }] });
  await expect(pages.next()).rejects.toMatchObject({ status: 503 });
});

it("stops repeated cursors and enforces an explicit page cap", async () => {
  const repeated = vi.fn(async () => page([], "same"));
  const pages = itemPages(repeated, endpoint);
  await pages.next(); await pages.next();
  await expect(pages.next()).rejects.toThrow(/repeated/);
  expect(repeated).toHaveBeenCalledTimes(2);
  const limited = itemPages(async () => page([], "more"), endpoint, { maxPages: 1 });
  await limited.next();
  await expect(limited.next()).rejects.toThrow(/pagination limit/);
});

it("cancels before requesting a continuation", async () => {
  const fetch = vi.fn(async () => page([], "more"));
  const owner = new AbortController();
  const pages = itemPages(fetch, endpoint, { signal: owner.signal });
  await pages.next();
  owner.abort();
  await expect(pages.next()).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledOnce();
});
