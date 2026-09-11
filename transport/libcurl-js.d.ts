declare module "libcurl.js/bundled" {
  export interface LibcurlResponse extends Response {
    raw_headers?: Array<[string, string]>;
  }

  export type LibcurlRequestInit = RequestInit;

  export interface LibcurlSession {
    base_url: string;
    fetch(
      input: RequestInfo | URL,
      init?: LibcurlRequestInit,
    ): Promise<LibcurlResponse>;
    export_cookies(): string;
    set_connections(total: number, cached: number, perHost: number): void;
    close(): void;
  }

  export interface LibcurlApi {
    ready: boolean;
    transport: "wisp" | "wsproxy" | unknown;
    websocket_url?: string;
    load_wasm(url?: string): Promise<void> | undefined;
    set_websocket(url: string): void;
    HTTPSession: new (options?: {
      enable_cookies?: boolean;
      cookie_jar?: string;
      proxy?: string;
    }) => LibcurlSession;
    logger: (level: string, message: string) => void;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  }

  export const libcurl: LibcurlApi;
}
