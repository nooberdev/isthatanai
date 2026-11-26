import { describe, expect, it } from "bun:test";
import { IsThatAnAI } from "../src/index";

// Mismo patrón de DOM falso que keyboard-detector.test.ts: el detector solo
// ve EventTargets, nunca un navegador real. El reloj se inyecta con `now`.

function fakeEvent(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, name);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, name, { value, configurable: true });
  }
  return event;
}

function key(type: "keydown" | "keyup", code: string, t: number): Event {
  return fakeEvent(type, { code, key: code, timeStamp: t, isTrusted: true });
}

function textInput(t: number): Event {
  return fakeEvent("beforeinput", { inputType: "insertText", timeStamp: t, isTrusted: true });
}

function pointerMove(t: number, pointerType: string): Event {
  return fakeEvent("pointermove", {
    clientX: t % 100,
    clientY: t % 70,
    timeStamp: t,
    pointerType,
    isTrusted: true,
  });
}

function fakeDom(): {
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  restore: () => void;
} {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  globals.window = windowTarget;
  globals.document = documentTarget;
  return {
    windowTarget,
    documentTarget,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    },
  };
}

function dispatchAll(target: EventTarget, events: Event[]): void {
  for (const event of events) target.dispatchEvent(event);
}

/** Secuencia de mando: 4/5/7 con jitter 300-900ms y pausas humanas > 1s. */
function remoteSequence(count: number, startT = 0): { events: Event[]; lastT: number } {
  const codes = ["ArrowRight", "ArrowDown", "Enter", "ArrowLeft", "ArrowUp", "Escape"];
  const events: Event[] = [];
  let t = startT;
  for (let i = 0; i < count; i += 1) {
    const code = codes[i % codes.length];
    events.push(key("keydown", code, t));
    events.push(key("keyup", code, t + 70 + ((i * 17) % 80)));
    const jitter = 300 + ((i * 71) % 600);
    const pause = i % 7 === 5 ? 1300 : 0;
    t += jitter + pause;
  }
  return { events, lastT: t };
}

/** Bot de flechas: 40 pulsaciones cada 60ms, sin jitter ni pausas. */
function arrowBot(count: number, startT = 0): { events: Event[]; lastT: number } {
  const events: Event[] = [];
  let t = startT;
  for (let i = 0; i < count; i += 1) {
    const code = i % 2 === 0 ? "ArrowRight" : "ArrowDown";
    events.push(key("keydown", code, t));
    events.push(key("keyup", code, t + 45));
    t += 60;
  }
  return { events, lastT: t };
}

describe("IsThatAnAI: perfil de dispositivo TV / mando", () => {
  it("mando con jitter y pausas: perfil tv inferido y humano tras confirmación", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();

      const first = remoteSequence(24);
      dispatchAll(documentTarget, first.events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");
      expect(detector.getSignalScores().keyboard).not.toBeNull();
      // Primera evaluación: queda pendiente de HUMAN_CONFIRM_MS.
      expect(detector.getVerdict().state).toBe("measuring");

      // Avanza el reloj de muestras con MÁS pulsaciones de mando (sin puntero,
      // que cambiaría el perfil a desktop).
      const more = remoteSequence(4, first.lastT + 400);
      dispatchAll(documentTarget, more.events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");
      expect(detector.getVerdict().state).toBe("human");
      expect(detector.getVerdict().score as number).toBeLessThan(0.25);
      detector.stop();
    } finally {
      restore();
    }
  });

  it('device: "tv" se respeta sin inferencia y sin evidencia queda measuring', () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ device: "tv", now: () => 0 });
      detector.start();
      expect(detector.getDeviceProfile()).toBe("tv");

      // 6 flechas: por debajo del mínimo de inferencia (8) y de evidencia
      // de teclado. Forzado tv, pero la señal se queda null (fail-closed).
      const events: Event[] = [];
      for (let i = 0; i < 6; i += 1) {
        events.push(key("keydown", "ArrowRight", 100 + i * 400));
        events.push(key("keyup", "ArrowRight", 150 + i * 400));
      }
      dispatchAll(documentTarget, events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");
      expect(detector.getSignalScores().keyboard).toBeNull();
      expect(detector.getVerdict()).toEqual({
        state: "measuring",
        score: null,
        confidence: 0,
        doubt: 1,
        reasons: [],
      });
      detector.stop();
    } finally {
      restore();
    }
  });

  it("bot de flechas cada 60ms sigue siendo ai (TV no es un pase libre)", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();

      const first = arrowBot(40);
      dispatchAll(documentTarget, first.events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");
      expect(detector.getSignalScores().keyboard as number).toBeGreaterThan(0.55);
      expect(detector.getVerdict().state).toBe("measuring");

      // Más actividad regular para superar AI_CONFIRM_MS sin usar puntero.
      const more = arrowBot(12, first.lastT + 300);
      dispatchAll(documentTarget, more.events);
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("un bot de flechas forzado a tv también sigue siendo ai", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ device: "tv", now: () => 0 });
      detector.start();
      const first = arrowBot(40);
      dispatchAll(documentTarget, first.events);
      detector.evaluate();
      const more = arrowBot(12, first.lastT + 300);
      dispatchAll(documentTarget, more.events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");
      expect(detector.getVerdict().state).toBe("ai");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("movimiento de puntero devuelve la inferencia automática a desktop", () => {
    const { windowTarget, documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      const remote = remoteSequence(20);
      dispatchAll(documentTarget, remote.events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");

      for (let i = 0; i < 12; i += 1) {
        windowTarget.dispatchEvent(pointerMove(20000 + i * 30, "mouse"));
      }
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("desktop");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("texto escrito devuelve la inferencia automática a desktop", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      dispatchAll(documentTarget, remoteSequence(20).events);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("tv");

      dispatchAll(documentTarget, [textInput(30000)]);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("desktop");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("pointerType !== 0 se reconoce como touch; sin puntero no se inventa perfil", () => {
    const { windowTarget, documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();

      // Letras con cadencia humana, sin ningún puntero: es desktop, no tv.
      const typed: Event[] = [];
      for (let i = 0; i < 20; i += 1) {
        typed.push(key("keydown", "KeyA", i * 200));
        typed.push(key("keyup", "KeyA", i * 200 + 90));
      }
      dispatchAll(documentTarget, typed);
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("desktop");

      windowTarget.dispatchEvent(pointerMove(5000, "touch"));
      detector.evaluate();
      expect(detector.getDeviceProfile()).toBe("touch");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("getVerdict mantiene su forma enumerable exacta", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ device: "tv", now: () => 0 });
      detector.start();
      dispatchAll(documentTarget, remoteSequence(24).events);
      detector.evaluate();

      const verdict = detector.getVerdict();
      expect(Object.keys(verdict)).toEqual(["state", "score", "confidence", "doubt", "reasons"]);
      const json = JSON.stringify(verdict);
      expect(json).not.toContain("device");
      expect(json).not.toContain("profile");
      expect(JSON.parse(json)).toEqual({
        state: verdict.state,
        score: verdict.score,
        confidence: verdict.confidence,
        doubt: verdict.doubt,
        reasons: verdict.reasons,
      });
      detector.stop();
    } finally {
      restore();
    }
  });

  it("importa y construye sin DOM, incluso con device forzado", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      'const detector = new IsThatAnAI({ device: "tv" });',
      "console.log(JSON.stringify({ profile: detector.getDeviceProfile(), verdict: detector.getVerdict() }));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(JSON.parse(output)).toEqual({
      profile: "tv",
      verdict: { state: "measuring", score: null, confidence: 0, doubt: 1, reasons: [] },
    });
  });
});
