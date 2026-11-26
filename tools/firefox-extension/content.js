// Content script: captura solo números. Nunca guarda eventos, URLs ni texto.
// La decisión de grabar la toma el background; este script solo puede enviar
// lotes mientras la sesión esté activa.
(() => {
  const BATCH_MS = 250;
  const MAX_LOCAL = 2048;
  let recording = false;
  let samples = [];
  let seq = 0;

  function pointerCode(type) {
    if (type === "pen") return 1;
    if (type === "touch") return 2;
    if (type === "mouse") return 0;
    return 3;
  }

  function sample(x, y, t, kind, pointerType, trusted) {
    seq += 1;
    samples.push({
      seq,
      x,
      y,
      t,
      kind,
      pointerType: pointerCode(pointerType),
      trusted: trusted ? 1 : 0,
    });
    if (samples.length > MAX_LOCAL) samples.shift();
  }

  function record(event, kind) {
    if (!recording) return;
    const mainX = event.clientX;
    const mainY = event.clientY;
    const mainT = event.timeStamp;
    const type = event.pointerType;
    const trusted = event.isTrusted;

    const coalesced =
      typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : null;
    if (coalesced && coalesced.length > 0) {
      for (let i = 0; i < coalesced.length; i += 1) {
        const item = coalesced[i];
        sample(
          typeof item.clientX === "number" ? item.clientX : mainX,
          typeof item.clientY === "number" ? item.clientY : mainY,
          typeof item.timeStamp === "number" ? item.timeStamp : mainT,
          kind,
          item.pointerType !== undefined ? item.pointerType : type,
          typeof item.isTrusted === "boolean" ? item.isTrusted : trusted,
        );
      }
    }
    sample(mainX, mainY, mainT, kind, type, trusted);
  }

  // pointermove: captura y pasivo. getCoalescedEvents recupera muestras intermedias.
  window.addEventListener(
    "pointermove",
    (event) => {
      record(event, 0);
    },
    { capture: true, passive: true },
  );

  // Entrada/salida: pointerenter/pointerleave NO burbujean; sin capture solo se
  // disparan al cruzar el límite del document, no al pasar entre hijos.
  document.addEventListener(
    "pointerenter",
    (event) => {
      record(event, 1);
    },
    { passive: true },
  );
  document.addEventListener(
    "pointerleave",
    (event) => {
      record(event, 2);
    },
    { passive: true },
  );

  function flush() {
    if (!recording || samples.length === 0) return;
    const batch = samples;
    samples = [];
    try {
      browser.runtime.sendMessage({ type: "samples", samples: batch });
    } catch (_error) {
      // Sin background no se guarda nada: se descarta el lote.
    }
  }

  setInterval(flush, BATCH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });

  browser.runtime.onMessage.addListener((message) => {
    if (!message || (message.type !== "recording" && message.type !== "status")) return;
    recording = Boolean(message.recording);
    if (recording) {
      samples = [];
      seq = 0;
    } else {
      flush();
    }
  });

  browser.runtime
    .sendMessage({ type: "status" })
    .then((reply) => {
      if (reply && typeof reply.recording === "boolean") recording = reply.recording;
    })
    .catch(() => {});
})();
