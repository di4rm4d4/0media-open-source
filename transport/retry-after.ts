const HTTP_DATE = /^(?:[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[a-z]+, \d{2}-[a-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[a-z]{3} [a-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/i;

function parseHttpDate(value: string): number {
  // HTTP's obsolete asctime format has no explicit timezone, but is still GMT.
  return HTTP_DATE.test(value) ? Date.parse(/GMT$/i.test(value) ? value : `${value} GMT`) : NaN;
}

/** Retry-After is either non-negative seconds or an HTTP date (RFC 9110). */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  // Date.parse also accepts values like "-1" and "1.5" as calendar dates.
  // Require an HTTP-date shape before letting it parse the month/time fields.
  const deadline = parseHttpDate(value);
  if (!Number.isFinite(deadline)) return undefined;
  // The response's clock avoids retrying early when the browser clock is ahead.
  const serverDate = parseHttpDate(headers.get("date") ?? "");
  return Math.max(0, deadline - (Number.isFinite(serverDate) ? serverDate : now));
}
