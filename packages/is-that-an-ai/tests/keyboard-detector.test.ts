import { describe, expect, it } from "bun:test";
import { IsThatAnAI } from "../src/index";

function fakeEvent(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, name);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, name, { value, configurable: true });
  }
  return event;
}

function key(type: "keydown" | "keyup", code: string, t: number, target?: unknown): Event {
  return fakeEvent(type, { code, key: code === "Space" ? " " : "a", timeStamp: t, target });
}

function paste(t: number, target?: unknown): Event {
  return fakeEvent("beforeinput", { inputType: "insertFromPaste", timeStamp: t, target });
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

describe("IsThatAnAI: teclado y texto (Etapa 7)", () => {
  it("start/stop gestionan los colectores y exponen muestras y contadores", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      expect(detector.getRecentKeys()).toEqual([]);
      expect(detector.getRecentInputs()).toEqual([]);
      detector.start();
      detector.start(); // idempotente

      let added = 0;
      // start ya ocurrió; comprobamos idempotencia con una segunda instancia.
      const originalAdd = documentTarget.addEventListener.bind(documentTarget);
      documentTarget.addEventListener = ((...args: Parameters<EventTarget["addEventListener"]>) => {
        added += 1;
        return originalAdd(...args);
      }) as typeof documentTarget.addEventListener;
      const other = new IsThatAnAI({ now: () => 0 });
      other.start();
      other.start();
      expect(added).toBe(4); // 2 de teclado + 2 de texto
      other.stop();

      dispatchAll(documentTarget, [
        key("keydown", "KeyA", 10),
        key("keyup", "KeyA", 45),
        paste(60),
      ]);
      const keys = detector.getRecentKeys();
      const inputs = detector.getRecentInputs();
      expect(keys.map((sample) => sample.seq)).toEqual([1, 2]);
      expect(keys.map((sample) => sample.category)).toEqual([0, 0]);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].inputType).toBe(1);
      expect(detector.getRecentKeys(1).map((sample) => sample.seq)).toEqual([2]);
      expect(detector.getRecentInputs(1)).toEqual([]);

      const stats = detector.getStats();
      expect(stats.keyCount).toBe(2);
      expect(stats.inputCount).toBe(1);
      // Las tres señales antiguas conservan su forma exacta.
      expect(detector.getSignalScores()).toEqual({ mouse: null, click: null, scroll: null });
      expect(detector.getSignalScores().keyboard).toBeNull();

      detector.stop();
      expect(detector.getRecentKeys()).toEqual([]);
      expect(detector.getRecentInputs()).toEqual([]);
      expect(detector.getStats().keyCount).toBe(0);
      expect(detector.getStats().inputCount).toBe(0);
      dispatchAll(documentTarget, [key("keydown", "KeyA", 100), paste(110)]);
      expect(detector.getRecentKeys()).toEqual([]);
      expect(detector.getRecentInputs()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("un bot que pega texto sin teclear da veredicto ai con score de teclado", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      const first = Array.from({ length: 5 }, (_, i) => paste(100 + i * 100));
      dispatchAll(documentTarget, first);
      detector.evaluate();
      expect(detector.getSignalScores().keyboard).toBeGreaterThan(0.55);
      expect(detector.getVerdict().state).toBe("measuring");

      // Más de AI_CONFIRM_MS después: el estado cambia a ai.
      dispatchAll(
        documentTarget,
        Array.from({ length: 5 }, (_, i) => paste(1200 + i * 100)),
      );
      detector.evaluate();
      const verdict = detector.getVerdict();
      expect(verdict.state).toBe("ai");
      expect(verdict.reasons.length).toBeGreaterThan(0);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("humano con pausas y errores en el detector no marca IA", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      const events: Event[] = [];
      let t = 0;
      for (let i = 0; i < 20; i += 1) {
        const dt = 55 + ((i * 41) % 130) + (i % 5 === 3 ? 750 : 0);
        events.push(key("keydown", "KeyA", t));
        events.push(key("keyup", "KeyA", t + 45 + ((i * 23) % 90)));
        t += dt;
      }
      dispatchAll(documentTarget, events);
      detector.evaluate();
      const score = detector.getSignalScores().keyboard;
      expect(score).not.toBeNull();
      expect(score as number).toBeLessThan(0.3);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("perfil E2E (20 letras 70-200ms, keyup inmediato) no da AGENTE", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      const events: Event[] = [];
      let t = 0;
      for (let i = 0; i < 20; i += 1) {
        events.push(key("keydown", "KeyA", t));
        events.push(key("keyup", "KeyA", t + 1)); // suelta al instante (CDP)
        t += 70 + ((i * 47) % 131);
      }
      dispatchAll(documentTarget, events);
      detector.evaluate();
      expect(detector.getStats().keyCount).toBe(40);
      // Con menos de 3000ms de ventana la señal de teclado no tiene evidencia.
      expect(detector.getSignalScores().keyboard).toBeNull();
      expect(detector.getVerdict().state).not.toBe("ai");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("el detector ignora teclado y texto de campos de contraseña", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      const password = { tagName: "INPUT", type: "password", value: "secreto" };
      dispatchAll(documentTarget, [key("keydown", "KeyA", 10, password), paste(20, password)]);
      expect(detector.getRecentKeys()).toEqual([]);
      expect(detector.getRecentInputs()).toEqual([]);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("importa sin DOM y expone la señal de teclado en null", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      "const detector = new IsThatAnAI();",
      "console.log(JSON.stringify({ keys: detector.getRecentKeys(), inputs: detector.getRecentInputs(), keyboard: detector.getSignalScores().keyboard }));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(JSON.parse(output)).toEqual({ keys: [], inputs: [], keyboard: null });
  });
});
