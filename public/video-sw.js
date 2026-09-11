/* Same-origin byte-range bridge. No CDN addresses, cookie jars or media cache. */
(() => {
  const protocol = "0media-video-v1";
  const prefix = "/_0media/video/";
  const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "x-0media-video-bridge": "3" };
  const errorResponse = (status = 410, size) => new Response(null, { status, headers: {
    ...noStore, ...(status === 416 && Number.isSafeInteger(size) ? { "content-range": `bytes */${size}` } : {}),
  } });
  self.addEventListener("message", event => {
    if (event.data?.protocol === protocol && event.data?.kind === "claim" && event.ports.length === 0
      && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
      event.waitUntil(self.clients.claim().then(
        () => event.source.postMessage({ protocol, kind: "claim-result", version: 3, ok: true }),
        () => event.source.postMessage({ protocol, kind: "claim-result", version: 3, ok: false }),
      )); return;
    }
    if (event.data?.protocol === protocol && event.data?.kind === "probe" && event.ports.length === 1
      && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
      event.ports[0].postMessage({ protocol, kind: "ready", version: 3 }); event.ports[0].close();
    }
  });
  self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
    // This listener runs before shell caching. Never allow even an invalid
    // reserved URL to fall through to an external network request.
    event.stopImmediatePropagation();
    const token = url.pathname.slice(prefix.length);
    if (url.search || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)
      || !["GET", "HEAD"].includes(event.request.method) || !event.clientId) {
      event.respondWith(errorResponse()); return;
    }
    let done;
    const lifetime = new Promise(resolve => { done = resolve; });
    event.waitUntil(lifetime);
    event.respondWith((async () => {
      const client = await self.clients.get(event.clientId);
      if (!client || new URL(client.url).origin !== self.location.origin) { done(); return errorResponse(); }
      return new Promise(resolve => {
        const channel = new MessageChannel();
        let body, pulling, expected = 0, written = 0, headersSeen = false, closed = false;
        const finish = () => {
          if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat);
          event.request.signal.removeEventListener("abort", failed);
          channel.port1.postMessage({ kind: "cancel" }); channel.port1.close();
          pulling?.(); done();
        };
        const failed = () => { if (closed) return;
          if (headersSeen) body?.error(new Error("Video stream ended."));
          else resolve(errorResponse(503)); finish(); };
        let timer = setTimeout(failed, 4000);
        const heartbeat = setInterval(() => { if (!closed && headersSeen) channel.port1.postMessage({ kind: "keepalive" }); }, 15_000);
        event.request.signal.addEventListener("abort", failed, { once: true });
        channel.port1.onmessage = received => {
          if (closed) return;
          const message = received.data;
          if (message?.kind === "error") {
            if (!headersSeen) resolve(errorResponse(message.status === 416 ? 416 : 410, message.size));
            else body?.error(new Error("Video stream ended."));
            finish(); return;
          }
          if (message?.kind === "headers" && !headersSeen) {
            if (![200, 206].includes(message.status) || !["video/mp4", "video/webm"].includes(message.type)
              || ![message.start, message.end, message.size].every(Number.isSafeInteger)
              || message.start < 0 || message.end < message.start || message.end >= message.size || message.size > 512 * 1024 * 1024) return failed();
            clearTimeout(timer); headersSeen = true;
            expected = message.end - message.start + 1;
            const headers = { ...noStore, "accept-ranges": "bytes", "content-type": message.type,
              "content-length": String(expected), ...(message.status === 206 ? { "content-range": `bytes ${message.start}-${message.end}/${message.size}` } : {}) };
            if (event.request?.method === "HEAD") { resolve(new Response(null, { status: message.status, headers })); finish(); return; }
            const stream = new ReadableStream({
              start(controller) { body = controller; },
              pull() { return new Promise(resolvePull => { pulling = resolvePull; timer = setTimeout(failed, 25_000); channel.port1.postMessage({ kind: "pull" }); }); },
              cancel() { finish(); },
            }, { highWaterMark: 0 });
            resolve(new Response(stream, { status: message.status, headers }));
          } else if (message?.kind === "chunk" && headersSeen && pulling) {
            clearTimeout(timer);
            if (!(message.bytes instanceof ArrayBuffer) || !message.bytes.byteLength || message.bytes.byteLength > 1024 * 1024
              || written + message.bytes.byteLength > expected) return failed();
            written += message.bytes.byteLength;
            body.enqueue(new Uint8Array(message.bytes));
            const resolvePull = pulling; pulling = undefined; resolvePull();
            if (written === expected) { body.close(); finish(); }
          } else failed();
        };
        client.postMessage({ protocol, kind: "range", token, range: event.request.headers.get("range"), method: event.request.method }, [channel.port2]);
        if (event.request.signal.aborted) failed();
      });
    })().catch(() => { done(); return errorResponse(503); }));
  });
})();
