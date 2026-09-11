export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ProtocolError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface VideoLease {
  url: string;
  release(): void;
  failure?(): { message: string; status: number; retryAfterMs?: number } | undefined;
  onInvalidated?(listener: () => void): () => void;
}
