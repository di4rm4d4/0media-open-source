import { waitForAbort } from "./abort";
import { readResponseBytes } from "./response";
import { retryAfterMs } from "./retry-after";
import { ProtocolError, type FetchLike } from "./types";

export interface HttpRequestOptions extends RequestInit {
  /** Covers initialization, response headers, and the complete body. Default: 30 seconds. */
  timeoutMs?: number;
  /** Limit on actual response bytes. Default: 256 KiB. */
  maxBytes?: number;
}

async function request<T>(fetch: FetchLike, input: RequestInfo | URL, options: HttpRequestOptions,
  decode: (response: Response, bytes: Uint8Array) => T): Promise<T> {
  const { timeoutMs = 30_000, maxBytes = 256 * 1024, ...init } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be an integer between 1 and 2147483647.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer.");
  const external = init.signal !== undefined ? init.signal : (input instanceof Request ? input.signal : undefined);
  external?.throwIfAborted();
  const owner = new AbortController();
  const abort = () => owner.abort(external?.reason);
  external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => owner.abort(new DOMException("Request timed out.", "TimeoutError")), timeoutMs);
  let response: Response | undefined;
  try {
    const pending = fetch(input, {
      ...init,
      redirect: init.redirect ?? "error",
      signal: owner.signal,
    });
    response = await waitForAbort(pending, owner.signal, late => {
      void late.body?.cancel().catch(() => undefined);
    });
    if (!response.ok) {
      throw new ProtocolError(`Request failed (HTTP ${response.status}).`, response.status, retryAfterMs(response.headers));
    }
    const bytes = await readResponseBytes(response, maxBytes, owner.signal);
    owner.signal.throwIfAborted();
    return decode(response, bytes);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abort);
    owner.abort(); // Also releases the pinned library's HTTP handle after EOF.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

/** One bounded request, with no automatic retries or credential storage. */
export function requestBytes(fetch: FetchLike, input: RequestInfo | URL, options: HttpRequestOptions = {}): Promise<Uint8Array> {
  return request(fetch, input, options, (_response, bytes) => bytes);
}

export function requestText(fetch: FetchLike, input: RequestInfo | URL, options: HttpRequestOptions = {}): Promise<string> {
  return request(fetch, input, options, (_response, bytes) => new TextDecoder().decode(bytes));
}

/** JSON remains unknown until the service adapter validates its shape. */
export function requestJson(fetch: FetchLike, input: RequestInfo | URL, options: HttpRequestOptions = {}): Promise<unknown> {
  return request(fetch, input, options, (response, bytes) => {
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!type || !/^application\/(?:json|[a-z0-9!#$%&'*+.^_`|~-]+\+json)$/.test(type)) {
      throw new ProtocolError("Expected an application/json or application/*+json response.", response.status);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ProtocolError("The response is not valid UTF-8 JSON.", response.status); }
  });
}
