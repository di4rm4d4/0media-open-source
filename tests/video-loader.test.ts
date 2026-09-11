import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoLoader, MAX_VIDEO_BYTES } from "../transport/media/video";

const source = "https://example.com/video.mp4";
const loaders: VideoLoader[] = [];
beforeEach(() => {
  let sequence = 0;
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: vi.fn(() => `blob:video-${++sequence}`), revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => {
  for (const loader of loaders.splice(0)) loader.close();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function setup(fetch: ConstructorParameters<typeof VideoLoader>[0]) {
  const loader = new VideoLoader(fetch); loaders.push(loader);
  loader.register("video", source); return loader;
}
const videoResponse = () => new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "content-type": "video/mp4" } });

describe("bounded encrypted video downloads", () => {
  it("uses only the injected TLS transport, omits CDN credentials and owns/revokes a blob lease", async () => {
    const fetch = vi.fn(async () => videoResponse());
    const loader = setup(fetch);
    const lease = await loader.load("video");
    expect(lease.url).toBe("blob:video-1");
    expect(fetch).toHaveBeenCalledWith(source, expect.objectContaining({ credentials: "omit", redirect: "error" }));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    lease.release(); lease.release(); loader.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(lease.url);
  });
  it("rejects foreign, credential-bearing, insecure and unknown sources before transport", async () => {
    const fetch = vi.fn(); const loader = setup(fetch);
    for (const url of ["https://evil.test/video.mp4", "http://example.com/video", "https://name:secret@example.com/video"]) {
      expect(() => loader.register("bad", url)).toThrow();
    }
    await expect(loader.load("unknown")).rejects.toThrow(/no longer available/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["text/html", "image/jpeg", "application/octet-stream"])("rejects %s bodies and aborts the HTTP handle even if stream cancel is inert", async type => {
    let networkActive = false;
    const fetch = vi.fn(async (_url, init) => {
      networkActive = true;
      init!.signal!.addEventListener("abort", () => { networkActive = false; });
      return new Response(new ReadableStream({ cancel() {} }), { headers: { "content-type": type } });
    });
    await expect(setup(fetch).load("video")).rejects.toThrow(/supported video/);
    expect(networkActive).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("enforces both declared and actual byte limits without creating a blob", async () => {
    const declared = setup(async () => new Response("", { headers: { "content-type": "video/mp4", "content-length": String(MAX_VIDEO_BYTES + 1) } }));
    await expect(declared.load("video")).rejects.toThrow(/too large/);
    let cancelled = false;
    const actual = setup(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_VIDEO_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } }));
    await expect(actual.load("video")).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("bounds active leases as well as downloads and frees capacity only on release", async () => {
    const fetch = vi.fn(async () => videoResponse()); const loader = setup(fetch);
    const one = await loader.load("video"); await loader.load("video");
    const third = loader.load("video");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    one.release(); await third;
    expect(fetch).toHaveBeenCalledTimes(3);
    loader.close(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    await expect(loader.load("video")).rejects.toThrow(/no longer available/);
  });
  it("uses the supplied smaller rendition only on explicit retry after oversize", async () => {
    const small = source + "?small";
    const fetch = vi.fn(async (url) => String(url) === small ? videoResponse()
      : new Response("", { headers: { "content-type": "video/mp4", "content-length": String(MAX_VIDEO_BYTES + 1) } }));
    const loader = setup(fetch);
    loader.register("video", source, [small]);
    await expect(loader.load("video")).rejects.toThrow(/smaller/);
    expect(fetch).toHaveBeenCalledOnce();
    await loader.load("video");
    expect(fetch).toHaveBeenLastCalledWith(small, expect.anything());
  });
  it("cancels queued videos without making a request or reserving a lease", async () => {
    const fetch = vi.fn(async () => videoResponse()); const loader = setup(fetch);
    const one = await loader.load("video"); await loader.load("video");
    const controller = new AbortController();
    const queued = loader.load("video", controller.signal).catch(error => error);
    controller.abort();
    expect((await queued).name).toBe("AbortError");
    one.release();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("times out headers and cancels a late response even if a transport ignores abort", async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const loader = setup(fetch);
    const result = loader.load("video").catch(error => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await result).message).toMatch(/timed out/);
    let cancelled = false;
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } }));
    await Promise.resolve(); await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("aborts a stalled body and never makes a post-abort blob", async () => {
    const controller = new AbortController(); let read = false;
    const loader = setup(async () => new Response(new ReadableStream({ pull() { read = true; } }), { headers: { "content-type": "video/mp4" } }));
    const result = loader.load("video", controller.signal).catch(error => error);
    await vi.waitFor(() => expect(read).toBe(true));
    controller.abort();
    expect((await result).name).toBe("AbortError");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("does not expose a transport exception's private URL", async () => {
    await expect(setup(async () => { throw new Error("secret-signed-url"); }).load("video")).rejects.toThrow("The encrypted video download did not finish.");
  });
});
