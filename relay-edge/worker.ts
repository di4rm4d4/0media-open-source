import { connect, type Socket } from "cloudflare:sockets";
import {
  RELAY_HTTP_HOST,
  acceptsBrowserOrigin,
  parseRelayTarget,
  selectsBinaryProtocol,
} from "./policy";

const CONNECT_TIMEOUT_MS = 8_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_CONNECTION_MS = 600_000;
const MAX_FRAME_BYTES = 65_536;
const MAX_BYTES_EACH_DIRECTION = 33_554_432;
const MAX_CONNECTIONS_PER_ISOLATE = 128;

interface Env {
  readonly RELEASE_SHA?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type ServerWebSocket = WebSocket & { accept(options?: { allowHalfOpen?: boolean }): void };

let activeConnections = 0;

function json(body: object, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-site",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function binaryPayloadLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return null;
}

async function binaryPayload(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError("binary payload required");
}

async function openSocket(hostname: string): Promise<Socket> {
  const socket = connect(
    { hostname, port: 443 },
    { allowHalfOpen: false, secureTransport: "off" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    return socket;
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function relayConnection(webSocket: ServerWebSocket, socket: Socket): Promise<void> {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let clientBytes = 0;
  let upstreamBytes = 0;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void;
  const completion = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const finish = (code: number, reason: string, notifyBrowser = true): void => {
    if (finished) return;
    finished = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    if (notifyBrowser) {
      try {
        webSocket.close(code, reason);
      } catch {
        // The browser may already have closed the WebSocket.
      }
    }
    settle();
  };

  const resetIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(1000, "idle timeout"), IDLE_TIMEOUT_MS);
  };

  let writeQueue = Promise.resolve();
  webSocket.addEventListener("message", (event) => {
    if (finished) return;
    const payloadLength = binaryPayloadLength(event.data);
    if (payloadLength === null) {
      finish(1003, "binary frames only");
      return;
    }
    if (payloadLength > MAX_FRAME_BYTES) {
      finish(1009, "frame limit exceeded");
      return;
    }
    if (payloadLength === 0) return;
    if (clientBytes + payloadLength > MAX_BYTES_EACH_DIRECTION) {
      finish(1009, "client byte limit exceeded");
      return;
    }
    clientBytes += payloadLength;
    resetIdleTimer();
    writeQueue = writeQueue
      .then(async () => writer.write(await binaryPayload(event.data)))
      .catch(() => finish(1011, "upstream write failed"));
  });
  webSocket.addEventListener("close", () => finish(1000, "client closed", false));
  webSocket.addEventListener("error", () => finish(1011, "client transport failed", false));

  webSocket.binaryType = "arraybuffer";
  webSocket.accept({ allowHalfOpen: false });
  resetIdleTimer();
  lifetimeTimer = setTimeout(
    () => finish(1000, "connection lifetime reached"),
    MAX_CONNECTION_MS,
  );

  const upstreamPump = (async (): Promise<void> => {
    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) {
          finish(1000, "upstream closed");
          return;
        }
        if (!value || value.byteLength === 0) continue;
        if (upstreamBytes + value.byteLength > MAX_BYTES_EACH_DIRECTION) {
          finish(1009, "upstream byte limit exceeded");
          return;
        }
        upstreamBytes += value.byteLength;
        resetIdleTimer();
        for (let offset = 0; offset < value.byteLength; offset += MAX_FRAME_BYTES) {
          webSocket.send(value.slice(offset, offset + MAX_FRAME_BYTES));
        }
      }
    } catch {
      finish(1011, "upstream read failed");
    }
  })();

  await completion;
  await Promise.allSettled([
    writeQueue,
    reader.cancel(),
    writer.abort("relay closed"),
    socket.close(),
  ]);
  await upstreamPump;
  reader.releaseLock();
  writer.releaseLock();
}

async function fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== RELAY_HTTP_HOST || (url.port !== "" && url.port !== "443")) {
    return json({ error: "not found" }, 404);
  }

  if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") {
    return json({
      status: "ok",
      service: "0media-relay",
      release: env.RELEASE_SHA ?? "development",
    });
  }

  const target = parseRelayTarget(url);
  if (
    request.method !== "GET" ||
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
    target === null ||
    !acceptsBrowserOrigin(request) ||
    !selectsBinaryProtocol(request)
  ) {
    return json({ error: "request rejected" }, 403);
  }
  if (activeConnections >= MAX_CONNECTIONS_PER_ISOLATE) {
    return json({ error: "relay capacity reached" }, 503, { "Retry-After": "5" });
  }

  activeConnections += 1;
  let socket: Socket;
  try {
    socket = await openSocket(target.host);
  } catch {
    activeConnections -= 1;
    return json({ error: "upstream unavailable" }, 502);
  }

  const pair = new WebSocketPair();
  const browser = pair[0];
  const server = pair[1] as ServerWebSocket;
  context.waitUntil(
    relayConnection(server, socket).finally(() => {
      activeConnections -= 1;
    }),
  );
  return new Response(null, {
    status: 101,
    headers: { "Sec-WebSocket-Protocol": "binary" },
    webSocket: browser,
  } as ResponseInit & { webSocket: WebSocket });
}

export default { fetch };
