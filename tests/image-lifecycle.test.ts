import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageLoader } from "../transport/media/images";
const source = (id: number) => `https://example.com/offline-${id}.jpg`;
const response = () => new Response("offline-image", { headers: { "content-type": "image/jpeg" } });
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:offline") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => vi.useRealTimers());
it("shares a pending image without letting one cancelled owner abort another", async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn((_url, _init) => new Promise<Response>(resolve => { finish = resolve; }));
  const loader = new ImageLoader(fetch);
  const first = new AbortController();
  const a = loader.load(source(1), first.signal).catch(error => error);
  const b = loader.load(source(1));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  first.abort();
  await a;
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
  finish(response());
  expect(await b).toBe("blob:offline");
  expect(await loader.load(source(1))).toBe("blob:offline");
  expect(fetch).toHaveBeenCalledOnce();
  loader.close();
});
it("admits at most four downloads and removes cancelled queued work", async () => {
  const fetch = vi.fn((_url, _init) => new Promise<Response>(() => {}));
  const loader = new ImageLoader(fetch);
  const controllers = Array.from({ length: 6 }, () => new AbortController());
  const results = controllers.map((controller, i) => loader.load(source(i), controller.signal).catch(error => error));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  controllers[4].abort(); controllers[5].abort();
  loader.close();
  await Promise.all(results);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
});
it("times out an uncooperative transport and never publishes its late image", async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const loader = new ImageLoader(fetch);
  const result = loader.load(source(1));
  await vi.advanceTimersByTimeAsync(20_001);
  expect(await result).toBeUndefined();
  finish(response());
  await vi.advanceTimersByTimeAsync(1);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  loader.close();
});

it("gives queued images a full network deadline after admission", async () => {
  vi.useFakeTimers();
  const finishes: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => finishes.push(resolve)));
  const loader = new ImageLoader(fetch);
  const pending = Array.from({ length: 5 }, (_, i) => loader.load(source(i)));
  await vi.advanceTimersByTimeAsync(19_000);
  expect(fetch).toHaveBeenCalledTimes(4);
  finishes[0](response());
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(2_000);
  finishes[4](response());
  expect(await pending[4]).toBe("blob:offline");
  await Promise.all(pending);
  loader.close();
});

it("releases an image by source and downloads it again on an explicit later load", async () => {
  let sequence = 0;
  vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:image-${++sequence}`);
  const fetch = vi.fn(async () => response());
  const loader = new ImageLoader(fetch);
  expect(await loader.load(source(1))).toBe("blob:image-1");
  loader.release(source(1));
  loader.release(source(1));
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image-1");
  expect(await loader.load(source(1))).toBe("blob:image-2");
  expect(fetch).toHaveBeenCalledTimes(2);
  loader.close();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it("discards a released source's late response without disturbing its replacement", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockImplementationOnce(async () => response());
  const loader = new ImageLoader(fetch);
  const pending = loader.load(source(1));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  loader.release(source(1));
  expect(await pending).toBeUndefined();
  expect(await loader.load(source(1))).toBe("blob:offline");
  const cancel = vi.fn();
  finish(new Response(new ReadableStream({ cancel })));
  await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  loader.close();
});
