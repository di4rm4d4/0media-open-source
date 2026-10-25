import { BrowserTlsTransport, requestJson, requestText } from "../transport/index.ts";

const form = document.querySelector("#request-form");
const relay = document.querySelector("#relay");
const status = document.querySelector("#status");
const output = document.querySelector("#response");
let transport;
let controller;

function setBusy(busy) {
  document.querySelector("#send").disabled = busy;
  document.querySelector("#cancel").disabled = !busy;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (controller) return;
  const owner = new AbortController();
  controller = owner;
  output.textContent = "";
  setBusy(true);
  try {
    if (!transport) {
      transport = new BrowserTlsTransport({ relayUrl: relay.value });
      relay.disabled = true; // The pinned runtime uses one relay per page.
    }
    const json = document.querySelector("#format").value === "json";
    const request = json ? requestJson : requestText;
    status.textContent = "Sending through your relay…";
    const result = await request(transport.fetch, document.querySelector("#url").value, {
      signal: owner.signal,
      timeoutMs: 30_000,
      maxBytes: 256 * 1024,
      credentials: "omit",
      headers: { accept: json ? "application/json" : "text/html,text/plain;q=0.9" },
    });
    owner.signal.throwIfAborted();
    output.textContent = json ? JSON.stringify(result, null, 2) : result;
    status.textContent = "Done. The response above is inert text.";
  } catch (error) {
    if (controller === owner) status.textContent = owner.signal.aborted ? "Cancelled." : error.message;
  } finally {
    owner.abort();
    if (controller === owner) {
      controller = undefined;
      setBusy(false);
    }
  }
});

document.querySelector("#cancel").addEventListener("click", () => controller?.abort());
document.querySelector("#disconnect").addEventListener("click", () => {
  controller?.abort();
  controller = undefined;
  transport?.close();
  transport = undefined;
  setBusy(false);
  output.textContent = "";
  status.textContent = "Session closed. Reload to change the relay.";
});
window.addEventListener("pagehide", () => { controller?.abort(); transport?.close(); });
