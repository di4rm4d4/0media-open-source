import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALLOWED_TLS_HOSTS, ALLOWED_TLS_SUFFIXES, assertAllowedTarget, normalizeRelayUrl } from "../transport/policy";

describe("application-independent transport policy", () => {
  it("matches the example-only backend defaults", () => {
    expect([...ALLOWED_TLS_HOSTS]).toEqual(["example.com"]);
    expect([...ALLOWED_TLS_SUFFIXES]).toEqual([]);
    expect(readFileSync("relay/zero_media_relay/policy.py", "utf8")).toContain('ALLOWED_TLS_HOSTS = frozenset({"example.com"})');
    expect(() => assertAllowedTarget(new URL("https://example.com/"))).not.toThrow();
  });
  it.each(["http://example.com/", "https://example.com:444/", "https://www.example.com/",
    "https://example.com.evil.test/", "https://evilexample.com/", "https://127.0.0.1/",
    "https://[::1]/", "https://name:password@example.com/", "https://example.com./", "https://example.com/#fragment"])("rejects %s", url => {
    expect(() => assertAllowedTarget(new URL(url))).toThrow();
  });
  it.each(["ws://127.0.0.1:8080/ws/", "ws://localhost:8080/ws/", "wss://relay.example.org/ws/"])("accepts explicit relay %s", url => {
    expect(normalizeRelayUrl(url)).toBe(url);
  });
  it.each(["ws://relay.example.org/ws/", "https://relay.example.org/ws/", "wss://u:p@relay.example.org/ws/",
    "wss://relay.example.org/ws/?token=secret", "wss://relay.example.org/other/", "wss://relay.example.org/ws/#fragment"])("rejects relay %s", url => {
    expect(() => normalizeRelayUrl(url)).toThrow();
  });
});
