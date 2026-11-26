// Etapa 9 — afinar: sensibilidad, accesibilidad explícita y perfiles detallados.
// Tests 100% deterministas: reloj inyectado, EventTargets y pistas de entorno
// falsas. Nunca se toca la red, el DOM real ni el reloj de pared.

import { describe, expect, it } from "bun:test";
import { DETAILED_TO_COARSE, inferDetailedDevice } from "../src/core/device-profile";
import { IsThatAnAI } from "../src/index";
import {
  AI_CONFIRM_MS,
  AI_MIN,
  HUMAN_CONFIRM_MS,
  HUMAN_MAX,
  SENSITIVITIES,
  SENSITIVITY_PRESETS,
} from "../src/scoring/score";
import type {
  DetectorOptions,
  InputSample,
  KeySample,
  PointerSample,
  Sensitivity,
  Verdict,
} from "../src/types";

const MEASURING: Verdict = {
  state: "measuring",
  score: null,
  confidence: 0,
  doubt: 1,
  reasons: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * EventTarget mínimo que entrega objetos planos a los listeners. Así podemos
 * fijar `isTrusted` de verdad (en Bun `Event.isTrusted` es non-configurable).
 */
class TestTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== "function" && (listener === null || typeof listener !== "object")) {
      return;
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as EventListenerOrEventListenerObject);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listeners.get(type)?.delete(listener as EventListenerOrEventListenerObject);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
    return true;
  }

  emit(type: string, props: Record<string, unknown>): void {
    this.dispatchEvent({ type, ...props } as unknown as Event);
  }
}

function move(x: number, t: number, trusted = true, pointerType = "mouse"): FakeEvent {
  return {
    type: "pointermove",
    clientX: x,
    clientY: x * 2,
    timeStamp: t,
    pointerType,
    isTrusted: trusted,
  };
}

/** Secuencia con saltos y pasos regulares: puntúa claramente como IA. */
function teleports(count: number, dt = 60, trusted = true, pointerType = "mouse"): FakeEvent[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % 8 === 0 ? 300 : 0), i * dt, trusted, pointerType),
  );
}

function key(type: "keydown" | "keyup", code: string, t: number, trusted = true): FakeEvent {
  return { type, code, key: code, timeStamp: t, isTrusted: trusted };
}

/** Bot de flechas: 40 pulsaciones regulares cada 60 ms. */
function arrowBot(count: number, dt = 60, trusted = true): FakeEvent[] {
  const events: FakeEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = i % 2 === 0 ? "ArrowRight" : "ArrowDown";
    events.push(key("keydown", code, i * dt, trusted));
    events.push(key("keyup", code, i * dt + 45, trusted));
  }
  return events;
}

function run(detector: IsThatAnAI, target: TestTarget, events: FakeEvent[], every = 5): void {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as FakeEvent;
    target.emit(event.type, event);
    if ((i + 1) % every === 0 || i === events.length - 1) detector.evaluate();
  }
}

/** Sesión aislada con target inyectado: sin window/document globals. */
function session<T>(
  options: DetectorOptions,
  body: (detector: IsThatAnAI, target: TestTarget) => T,
): T {
  const detector = new IsThatAnAI({ locale: "en", ...options });
  const target = new TestTarget();
  detector.attachTo(target);
  detector.start();
  try {
    return body(detector, target);
  } finally {
    detector.stop();
  }
}

/** Sustituye navigator/screen por objetos falsos y restaura los descriptores. */
function withEnv(nav: unknown, screen: unknown): () => void {
  const names = ["navigator", "screen"] as const;
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  if (nav === undefined) Reflect.deleteProperty(globalThis, "navigator");
  else
    Object.defineProperty(globalThis, "navigator", {
      value: nav,
      configurable: true,
      writable: true,
    });
  if (screen === undefined) Reflect.deleteProperty(globalThis, "screen");
  else
    Object.defineProperty(globalThis, "screen", {
      value: screen,
      configurable: true,
      writable: true,
    });
  return () => {
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i] as PropertyDescriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  };
}

function pointerSample(over: Partial<PointerSample> = {}): PointerSample {
  return { seq: 1, x: 0, y: 0, t: 0, kind: 0, pointerType: 0, trusted: 1, ...over };
}

function keySample(category: KeySample["category"], t: number): KeySample {
  return { seq: 1, t, kind: 0, category, trusted: 1 };
}

const textInput: InputSample = { seq: 1, t: 0, kind: 0, inputType: 0, trusted: 1 };

// ---------------------------------------------------------------------------
// 1. Sensibilidad
// ---------------------------------------------------------------------------

describe("Etapa 9: sensibilidad", () => {
  it("presets congelados con normal exactamente igual a los defaults históricos", () => {
    expect(Object.isFrozen(SENSITIVITY_PRESETS)).toBe(true);
    expect(SENSITIVITIES).toEqual(["estricto", "normal", "relajado"]);
    for (const name of SENSITIVITIES) {
      expect(Object.isFrozen(SENSITIVITY_PRESETS[name])).toBe(true);
      expect(Object.isFrozen(SENSITIVITY_PRESETS[name].thresholds)).toBe(true);
      expect(Object.isFrozen(SENSITIVITY_PRESETS[name].confirmMs)).toBe(true);
    }

    expect(SENSITIVITY_PRESETS.normal).toEqual({
      thresholds: { humanMax: HUMAN_MAX, aiMin: AI_MIN },
      confirmMs: { human: HUMAN_CONFIRM_MS, ai: AI_CONFIRM_MS },
    });

    const strict = SENSITIVITY_PRESETS.estricto;
    const normal = SENSITIVITY_PRESETS.normal;
    const relaxed = SENSITIVITY_PRESETS.relajado;
    expect(strict.thresholds.humanMax).toBeLessThan(normal.thresholds.humanMax);
    expect(normal.thresholds.humanMax).toBeLessThan(relaxed.thresholds.humanMax);
    expect(strict.thresholds.aiMin).toBeLessThan(normal.thresholds.aiMin);
    expect(normal.thresholds.aiMin).toBeLessThan(relaxed.thresholds.aiMin);
    expect(strict.confirmMs.human).toBeLessThan(normal.confirmMs.human);
    expect(normal.confirmMs.human).toBeLessThan(relaxed.confirmMs.human);
    expect(strict.confirmMs.ai).toBeLessThan(normal.confirmMs.ai);
    expect(normal.confirmMs.ai).toBeLessThan(relaxed.confirmMs.ai);
  });

  it("configure aplica el preset y los valores explícitos lo sobrescriben", () => {
    const detector = new IsThatAnAI({ now: () => 0 });
    expect(detector.getSensitivity()).toBe("normal");
    expect(detector.getConfig().thresholds).toEqual({ humanMax: HUMAN_MAX, aiMin: AI_MIN });
    expect(detector.getConfig().confirmMs).toEqual({
      human: HUMAN_CONFIRM_MS,
      ai: AI_CONFIRM_MS,
    });

    detector.configure({ sensitivity: "estricto" });
    expect(detector.getSensitivity()).toBe("estricto");
    expect(detector.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.estricto.thresholds);
    expect(detector.getConfig().confirmMs).toEqual(SENSITIVITY_PRESETS.estricto.confirmMs);

    // Solo aiMin/human se escriben; el resto del preset se conserva.
    detector.configure({
      sensitivity: "relajado",
      thresholds: { aiMin: 0.8 },
      confirmMs: { ai: 1234 },
    });
    expect(detector.getSensitivity()).toBe("relajado");
    expect(detector.getConfig().thresholds).toEqual({
      humanMax: SENSITIVITY_PRESETS.relajado.thresholds.humanMax,
      aiMin: 0.8,
    });
    expect(detector.getConfig().confirmMs).toEqual({
      human: SENSITIVITY_PRESETS.relajado.confirmMs.human,
      ai: 1234,
    });

    // Valor hostil se ignora; bandas inválidas vuelven al preset (fail closed).
    detector.configure({ sensitivity: "raro" as Sensitivity });
    expect(detector.getSensitivity()).toBe("relajado");
    detector.configure({
      sensitivity: "estricto",
      thresholds: { humanMax: 0.9, aiMin: 0.1 },
    });
    expect(detector.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.estricto.thresholds);

    // Opción del constructor.
    const forced = new IsThatAnAI({ now: () => 0, sensitivity: "relajado" });
    expect(forced.getSensitivity()).toBe("relajado");
    expect(forced.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.relajado.thresholds);
  });

  it("estricto confirma IA antes que normal con la misma secuencia", () => {
    // 10 muestras dan la primera puntuación (t=900); con 15 (t=1400) han
    // pasado 500 ms: suficiente para `estricto` (350 ms), no para `normal`.
    const stateAfter15 = (sensitivity: Sensitivity): string =>
      session({ now: () => 0, sensitivity }, (detector, target) => {
        run(detector, target, teleports(15, 100), 5);
        return detector.getVerdict().state;
      });

    expect(stateAfter15("estricto")).toBe("ai");
    expect(stateAfter15("normal")).toBe("measuring");
  });
});

// ---------------------------------------------------------------------------
// 2. Accesibilidad
// ---------------------------------------------------------------------------

describe("Etapa 9: modo accesibilidad", () => {
  it("mouse real puntúa; mouse sin evidencia real nunca se usa como prueba de IA", () => {
    const real = session({ now: () => 0, accessibility: true }, (detector, target) => {
      run(detector, target, teleports(40), 5);
      return detector.getVerdict();
    });
    expect(real.state).toBe("ai");
    expect(real.score as number).toBeGreaterThan(AI_MIN);

    const synthetic = session({ now: () => 0, accessibility: true }, (detector, target) => {
      run(detector, target, teleports(40, 60, false), 5);
      return detector.getVerdict();
    });
    expect(synthetic).toEqual(MEASURING);
    expect(synthetic.score).toBeNull();
  });

  it("teclado y touch siguen puntuando con normalidad", () => {
    const restore = withEnv(undefined, undefined);
    try {
      const keyboard = session({ now: () => 0, accessibility: true }, (detector, target) => {
        run(detector, target, arrowBot(40), 5);
        return {
          state: detector.getVerdict().state,
          keyboardScore: detector.getSignalScores().keyboard,
          mouseScore: detector.getSignalScores().mouse,
        };
      });
      expect(keyboard.keyboardScore).not.toBeNull();
      expect(keyboard.mouseScore).toBeNull();
      expect(keyboard.state).toBe("ai");

      const touch = session({ now: () => 0, accessibility: true }, (detector, target) => {
        run(detector, target, teleports(40, 60, true, "touch"), 5);
        return {
          score: detector.getVerdict().score,
          detail: detector.getDetailedDevice(),
          coarse: detector.getDeviceProfile(),
        };
      });
      expect(touch.score).not.toBeNull();
      expect(touch.detail).toBe("touch");
      expect(touch.coarse).toBe("touch");
    } finally {
      restore();
    }
  });

  it("fail closed: sin evidencia NUNCA pasa a humano", () => {
    session({ now: () => 0, accessibility: true }, (detector) => {
      expect(detector.getAccessibility()).toBe(true);
      detector.evaluate();
      expect(detector.getVerdict()).toEqual(MEASURING);
      expect(detector.getSignalScores().mouse).toBeNull();
      expect(detector.getSignalScores().keyboard).toBeNull();
    });
    session({ now: () => 0, accessibility: true }, (detector, target) => {
      run(detector, target, teleports(6), 5);
      expect(detector.getVerdict().state).toBe("measuring");
    });
  });

  it("auto se activa con perfil táctil y se lee con getAccessibility()", () => {
    const restore = withEnv(
      { maxTouchPoints: 5, userAgent: "Mozilla/5.0 (iPhone)" },
      { width: 390 },
    );
    try {
      session({ now: () => 0, accessibility: "auto" }, (detector, target) => {
        expect(detector.getAccessibility()).toBe("auto");
        expect(detector.getDetailedDevice()).toBe("celular");
        run(detector, target, teleports(40, 60, false), 5);
        // Con auto activo el mouse sintético se ignora: measuring, no IA.
        expect(detector.getVerdict()).toEqual(MEASURING);
      });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Perfiles detallados
// ---------------------------------------------------------------------------

describe("Etapa 9: perfiles de dispositivo detallados", () => {
  it("inferDetailedDevice es pura y usa muestras + pistas numéricas", () => {
    expect(inferDetailedDevice([], [], [])).toBe("computadora");
    expect(inferDetailedDevice([], [], [], { maxTouchPoints: 5, screenWidth: 390 })).toBe(
      "celular",
    );
    expect(inferDetailedDevice([], [], [], { maxTouchPoints: 5, screenWidth: 900 })).toBe("tablet");
    expect(inferDetailedDevice([], [], [], { mobile: true, screenWidth: 1024 })).toBe("celular");
    expect(inferDetailedDevice([], [], [], { maxTouchPoints: 1 })).toBe("touch");

    const touchPointer = [pointerSample({ pointerType: 2 })];
    expect(inferDetailedDevice(touchPointer, [], [])).toBe("touch");
    expect(inferDetailedDevice(touchPointer, [], [], { screenWidth: 800 })).toBe("tablet");
    expect(inferDetailedDevice(touchPointer, [], [], { screenWidth: 390 })).toBe("celular");

    const mouseMovement = [pointerSample({ kind: 0 })];
    expect(inferDetailedDevice(mouseMovement, [], [], { screenWidth: 1280 })).toBe("laptop");
    expect(inferDetailedDevice(mouseMovement, [], [], { screenWidth: 1920 })).toBe("computadora");
    expect(inferDetailedDevice([], [], [textInput], { screenWidth: 1366 })).toBe("laptop");

    const remote = Array.from({ length: 10 }, (_, i) => keySample(4, i * 300));
    expect(inferDetailedDevice([], remote, [])).toBe("tv");
  });

  it("el mapeo al perfil grueso conserva la compatibilidad", () => {
    expect(DETAILED_TO_COARSE).toEqual({
      computadora: "desktop",
      laptop: "desktop",
      celular: "touch",
      tablet: "touch",
      tv: "tv",
      touch: "touch",
    });
    expect(Object.isFrozen(DETAILED_TO_COARSE)).toBe(true);
  });

  it("el detalle inferido en start() no cambia el perfil grueso", () => {
    const restore = withEnv({ maxTouchPoints: 5, userAgent: "Mozilla/5.0" }, { width: 900 });
    try {
      session({ now: () => 0 }, (detector, target) => {
        expect(detector.getDetailedDevice()).toBe("tablet");
        // Sin muestras, el perfil grueso sigue siendo `desktop` como siempre.
        expect(detector.getDeviceProfile()).toBe("desktop");
        run(detector, target, teleports(20, 60, true, "touch"), 5);
        expect(detector.getDeviceProfile()).toBe("touch");
        expect(detector.getDetailedDevice()).toBe("tablet");
      });

      session({ now: () => 0, device: "tv", detailedDevice: "computadora" }, (detector) => {
        expect(detector.getDeviceProfile()).toBe("tv");
        expect(detector.getDetailedDevice()).toBe("computadora");
        expect(detector.getScoreBreakdown().accessibility.device).toBe("tv");
      });
    } finally {
      restore();
    }
  });

  it("detailedDevice forzado gana a la inferencia (constructor y configure)", () => {
    const detector = new IsThatAnAI({ now: () => 0, detailedDevice: "laptop" });
    expect(detector.getDetailedDevice()).toBe("laptop");
    detector.configure({ detailedDevice: "tv" });
    expect(detector.getDetailedDevice()).toBe("tv");
    expect(detector.getDeviceProfile()).toBe("desktop"); // no se filtra al grueso
    detector.configure({ detailedDevice: "raro" as "auto" });
    expect(detector.getDetailedDevice()).toBe("tv"); // inválido se ignora
  });
});

// ---------------------------------------------------------------------------
// 4. SSR y compatibilidad hacia atrás
// ---------------------------------------------------------------------------

describe("Etapa 9: SSR y backwards compatibility", () => {
  it("constructor y getters no leen el DOM; pistas hostiles no lanzan", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("acceso hostil al entorno");
        },
      },
    );
    const restore = withEnv(hostile, hostile);
    try {
      const detector = new IsThatAnAI({ now: () => 0, locale: "en" });
      expect(detector.getSensitivity()).toBe("normal");
      expect(detector.getAccessibility()).toBe(false);
      expect(detector.getDetailedDevice()).toBe("computadora");
      expect(() => {
        detector.attachTo(new EventTarget());
        detector.start();
      }).not.toThrow();
      expect(detector.getDetailedDevice()).toBe("computadora");
      detector.stop();
    } finally {
      restore();
    }
  });

  it("importar/construir sin window/document/navigator funciona", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      'const d = new IsThatAnAI({ locale: "en" });',
      'if (d.getDetailedDevice() !== "computadora") throw new Error("detalle no SSR");',
      'if (d.getSensitivity() !== "normal") throw new Error("sensibilidad no SSR");',
      'if (d.getAccessibility() !== false) throw new Error("accesibilidad no SSR");',
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  });

  it("sin opciones nuevas: getConfig y scores son idénticos a los defaults", () => {
    function runSession(extra: DetectorOptions): {
      config: ReturnType<IsThatAnAI["getConfig"]>;
      verdict: Verdict;
      scores: ReturnType<IsThatAnAI["getSignalScores"]>;
    } {
      return session({ now: () => 0, ...extra }, (detector, target) => {
        run(detector, target, teleports(30), 5);
        return {
          config: detector.getConfig(),
          verdict: detector.getVerdict(),
          scores: detector.getSignalScores(),
        };
      });
    }

    const plain = runSession({});
    const explicit = runSession({
      sensitivity: "normal",
      accessibility: false,
      detailedDevice: "auto",
    });
    expect(Object.keys(plain.config)).toEqual([
      "thresholds",
      "signalWeights",
      "device",
      "combination",
      "accessibilityProtection",
      "confirmMs",
      "emaAlpha",
    ]);
    expect(plain.config).toEqual(explicit.config);
    expect(plain.verdict).toEqual(explicit.verdict);
    expect(plain.scores).toEqual(explicit.scores);
    expect(plain.verdict.state).toBe("ai");
    expect(plain.verdict.score).not.toBeNull();
  });
});
