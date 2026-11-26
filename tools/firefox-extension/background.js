// Background: guarda SOLO números en memoria. Sin red, sin almacenamiento,
// sin URLs. El archivo se descarga solo cuando el usuario pulsa "Exportar JSON".
(() => {
  let recording = false;
  let label = "humano";
  let startedAtMs = 0;
  let endedAtMs = 0;
  let seq = 0;
  let samples = [];

  function notifyTabs() {
    browser.tabs
      .query({})
      .then((tabs) => {
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          browser.tabs.sendMessage(tab.id, { type: "recording", recording }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  function start(recLabel) {
    label = recLabel === "bot" ? "bot" : "humano";
    recording = true;
    startedAtMs = Date.now();
    endedAtMs = startedAtMs;
    seq = 0;
    samples = [];
    notifyTabs();
  }

  function stop() {
    if (!recording) return;
    recording = false;
    endedAtMs = Date.now();
    notifyTabs();
  }

  function exportJson() {
    if (samples.length === 0) return;
    const payload = {
      version: 1,
      label,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs || Date.now()).toISOString(),
      durationMs: (endedAtMs || Date.now()) - startedAtMs,
      sampleCount: samples.length,
      samples,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "_");
    browser.downloads
      .download({
        url,
        filename: `isthatanai-firefox-${label}-${stamp}.json`,
        saveAs: false,
      })
      .then(() => {
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 60000);
      })
      .catch(() => {
        URL.revokeObjectURL(url);
      });
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.type === "status") {
      return Promise.resolve({
        recording,
        label,
        sampleCount: samples.length,
        durationMs: recording ? Date.now() - startedAtMs : endedAtMs - startedAtMs,
      });
    }
    if (message.type === "start") {
      start(message.label);
      return Promise.resolve({ recording: true });
    }
    if (message.type === "stop") {
      stop();
      return Promise.resolve({ recording: false });
    }
    if (message.type === "export") {
      exportJson();
      return Promise.resolve({ sampleCount: samples.length });
    }
    if (message.type === "samples" && recording && Array.isArray(message.samples)) {
      const tabId = sender?.tab ? sender.tab.id : null;
      for (const item of message.samples) {
        seq += 1;
        samples.push({
          seq,
          x: item.x,
          y: item.y,
          t: item.t,
          kind: item.kind,
          pointerType: item.pointerType,
          trusted: item.trusted,
          tabId,
        });
      }
    }
    return undefined;
  });
})();
