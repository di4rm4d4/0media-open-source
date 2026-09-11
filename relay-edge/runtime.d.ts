declare module "cloudflare:sockets" {
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }

  export function connect(
    address: { hostname: string; port: number },
    options?: { allowHalfOpen?: boolean; secureTransport?: "off" | "on" | "starttls" },
  ): Socket;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};
