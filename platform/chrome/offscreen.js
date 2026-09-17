// Offscreen document. Exists for one reason: while a run is in flight, message the
// service worker every 20 s so Chrome's 30 s idle timer never fires and kills the loop.
// Messages from an offscreen document reset the worker's timers (documented behaviour).

let timer = null;

function tick() {
  chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === "keepalive-start") {
    if (!timer) timer = setInterval(tick, 20_000);
    reply({ ok: true, running: true });
  } else if (msg.type === "keepalive-stop") {
    clearInterval(timer);
    timer = null;
    reply({ ok: true, running: false });
  }
  return true;
});

timer = setInterval(tick, 20_000);
