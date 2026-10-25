import { expect, it, vi } from "vitest";
import { readResponseBytes } from "../transport/response";

it("collects a bounded streamed body", async () => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.enqueue(new Uint8Array([3]));
    controller.close();
  } }));
  expect([...await readResponseBytes(response, 3)]).toEqual([1, 2, 3]);
});

it("cancels over-limit bodies even when Content-Length lies", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(10));
  }, cancel }), { headers: { "content-length": "1" } });
  await expect(readResponseBytes(response, 9)).rejects.toThrow(/9-byte limit/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels a stalled body when the owning request is aborted", async () => {
  const cancel = vi.fn();
  const owner = new AbortController();
  const pending = readResponseBytes(new Response(new ReadableStream({ cancel })), 100, owner.signal);
  owner.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("does not wait for a source's stalled cancel hook after exceeding the byte bound", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2)); }, cancel,
  }));
  await expect(readResponseBytes(response, 1)).rejects.toThrow(/limit/);
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
});
