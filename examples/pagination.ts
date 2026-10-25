import { ProtocolError, requestJson, type FetchLike } from "../transport/index";

export interface Item { id: string; title: string }
interface Page { items: Item[]; nextCursor: string | null }

// This is an example contract for an API you control, not a social platform's API.
function parsePage(value: unknown): Page {
  if (!value || typeof value !== "object") throw new ProtocolError("Expected an items page.");
  const { items, nextCursor } = value as Record<string, unknown>;
  if (!Array.isArray(items) || items.length > 100
    || nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048)) {
    throw new ProtocolError("Unexpected page shape.");
  }
  return { nextCursor, items: items.map(item => {
    if (!item || typeof item.id !== "string" || typeof item.title !== "string") {
      throw new ProtocolError("Unexpected item shape.");
    }
    return { id: item.id, title: item.title };
  }) };
}

/** Requests the next page only when the consumer asks for it. */
export async function* itemPages(fetch: FetchLike, endpoint: string,
  { signal, maxPages = 10 }: { signal?: AbortSignal; maxPages?: number } = {}): AsyncGenerator<Item[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive safe integer.");
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const url = new URL(endpoint);
    url.searchParams.delete("cursor");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = parsePage(await requestJson(fetch, url, {
      signal, headers: { accept: "application/json" }, credentials: "omit",
      maxBytes: 512 * 1024, timeoutMs: 20_000,
    }));
    yield page.items;
    if (page.nextCursor === null) return;
    if (seen.has(page.nextCursor)) throw new ProtocolError("The API repeated a pagination cursor.");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new ProtocolError("The pagination limit was reached. Resume explicitly if more pages are needed.");
}
