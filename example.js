import { BrowserTlsTransport, readResponseBytes } from "./transport/index.ts";

const form = document.querySelector("#request-form");
const status = document.querySelector("#status");
const output = document.querySelector("#response");
const relay = document.querySelector("#relay");
const cookies = document.querySelector("#cookies");
let transport;
let controller;

function setBusy(busy) {
  document.querySelector("#send").disabled = busy;
  document.querySelector("#cancel").disabled = !busy;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (controller) return;
  output.textContent = "";
  const owner = new AbortController();
  controller = owner;
  const timeout = setTimeout(() => owner.abort(), 30_000);
  setBusy(true);
  try {
    if (!transport) {
      transport = new BrowserTlsTransport({ relayUrl: relay.value, enableCookies: cookies.checked });
      relay.disabled = true; // libcurl.js has one relay setting per page.
      cookies.disabled = true;
    }
    const headers = new Headers();
    for (const line of document.querySelector("#headers").value.split("\n")) {
      if (!line.trim()) continue;
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("Each header needs a name and a colon.");
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const method = document.querySelector("#method").value;
    const body = document.querySelector("#body").value;
    if (new TextEncoder().encode(body).length > 65536) throw new Error("Example request body is limited to 64 KiB.");
    status.textContent = "Sending through your relay…";
    const response = await transport.fetch(document.querySelector("#url").value, {
      method, headers, body: method === "POST" ? body : undefined,
      credentials: cookies.checked ? "include" : "omit",
      redirect: "manual", signal: owner.signal,
    });
    const bytes = await readResponseBytes(response, 256 * 1024, owner.signal);
    owner.signal.throwIfAborted();
    // Never insert an untrusted upstream response with innerHTML.
    output.textContent = `HTTP ${response.status}\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${new TextDecoder().decode(bytes)}`;
    status.textContent = "Done. The response above is inert text.";
  } catch (error) {
    if (controller === owner) status.textContent = owner.signal.aborted ? "Cancelled or timed out." : error.message;
  } finally {
    clearTimeout(timeout);
    owner.abort(); // Release the HTTP handle even after consuming its body.
    if (controller === owner) { controller = undefined; setBusy(false); }
  }
});

document.querySelector("#cancel").addEventListener("click", () => controller?.abort());
document.querySelector("#disconnect").addEventListener("click", () => {
  controller?.abort();
  controller = undefined;
  setBusy(false);
  transport?.close();
  transport = undefined;
  output.textContent = "";
  status.textContent = "Session closed. Cookies were discarded. Reload to change relay or cookie mode.";
});
window.addEventListener("pagehide", () => { controller?.abort(); transport?.close(); });
