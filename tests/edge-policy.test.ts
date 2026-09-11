import { describe, expect, it } from "vitest";
import {
  EDGE_RELAY_HOSTS,
  EDGE_RELAY_SUFFIXES,
  RELAY_BROWSER_ORIGIN,
  acceptsBrowserOrigin,
  parseRelayTarget,
  selectsBinaryProtocol,
} from "../relay-edge/policy";
import { ALLOWED_TLS_HOSTS, ALLOWED_TLS_SUFFIXES } from "../transport/policy";

function websocketRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://relay.example.org/ws/example.com:443", { headers });
}

describe("Cloudflare edge relay policy", () => {
  it("keeps the edge and browser target allowlists identical", () => {
    expect(new Set(EDGE_RELAY_HOSTS)).toEqual(ALLOWED_TLS_HOSTS);
    expect(new Set(EDGE_RELAY_SUFFIXES)).toEqual(ALLOWED_TLS_SUFFIXES);
  });

  it.each([
    ["https://relay.example.org/ws/example.com%3A443", { host: "example.com", port: 443 }],
    ["https://relay.example.org/ws/example.com:443", { host: "example.com", port: 443 }],
  ])("accepts the exact wsproxy shape %s", (value, expected) => {
    expect(parseRelayTarget(new URL(value))).toEqual(expected);
  });

  it.each([
    "http://relay.example.org/ws/example.com:443",
    "https://client.example.org/ws/example.com:443",
    "https://relay.example.org/ws/example.com",
    "https://relay.example.org/ws/example.com:80",
    "https://relay.example.org/ws/EXAMPLE.com:443",
    "https://relay.example.org/ws/127.0.0.1:443",
    "https://relay.example.org/ws/other.example.com:443",
    "https://relay.example.org/ws/evilexample.com:443",
    "https://relay.example.org/ws/example.com.evil.example:443",
    "https://relay.example.org/ws/example.com%253A443",
    "https://relay.example.org/ws/example.com:443/extra",
    "https://relay.example.org/ws/example.com:443?target=evil.example",
  ])("rejects out-of-contract target %s", (value) => {
    expect(parseRelayTarget(new URL(value))).toBeNull();
  });

  it("requires the exact browser origin and binary wsproxy protocol", () => {
    const valid = websocketRequest({
      Origin: RELAY_BROWSER_ORIGIN,
      "Sec-WebSocket-Protocol": "chat, binary",
    });
    expect(acceptsBrowserOrigin(valid)).toBe(true);
    expect(selectsBinaryProtocol(valid)).toBe(true);

    expect(acceptsBrowserOrigin(websocketRequest({ Origin: "https://evil.example" }))).toBe(false);
    expect(selectsBinaryProtocol(websocketRequest({ "Sec-WebSocket-Protocol": "chat" }))).toBe(false);
  });
});
