(() => {
  const status = document.getElementById("status");

  function refresh() {
    browser.runtime
      .sendMessage({ type: "status" })
      .then((reply) => {
        if (!reply) return;
        const seconds = ((reply.durationMs || 0) / 1000).toFixed(1);
        status.textContent = reply.recording
          ? `Grabando ${reply.label} · ${seconds} s · ${reply.sampleCount} muestras`
          : `Detenido · ${seconds} s · ${reply.sampleCount} muestras`;
      })
      .catch(() => {
        status.textContent = "Sin conexión con el background";
      });
  }

  document.getElementById("human").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "start", label: "humano" }).then(refresh);
  });
  document.getElementById("bot").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "start", label: "bot" }).then(refresh);
  });
  document.getElementById("stop").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "stop" }).then(refresh);
  });
  document.getElementById("export").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "export" }).then(refresh);
  });

  refresh();
  setInterval(refresh, 500);
})();
