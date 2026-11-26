// Etapa 11 — superficie pública aditiva. Tests 100% deterministas: reloj
// inyectado, EventTarget propio, globals falsos y timer reemplazado. Sin DOM
// real, sin red, sin storage. No se tocan los scores calibrados existentes.

import { describe, expect, it, spyOn } from "bun:test";
import { autoStart } from "../src/auto-start";
import { IsThatAnAI } from "../src/core/detector";
import { ScoreComputer } from "../src/scoring/score";
import type { DetectorOptions, Signal } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** EventTarget mínimo que entrega objetos planos (permite fijar isTrusted). */
class TestTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
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

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ): void {
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

type Emission = [type: string, props: Record<string, unknown>];
type Clock = { value: number };

function emit(target: TestTarget, clock: Clock, events: Emission[]): void {
  for (const [type, props] of events) {
    const t = props.timeStamp;
    if (typeof t === "number" && Number.isFinite(t)) clock.value = t;
    target.emit(type, props);
  }
}

/** Movimientos rectos (perfil IA): puntaje alto. */
function botMoves(count: number, t0 = 0, dt = 60, step = 10, x0 = 0): Emission[] {
  return Array.from({ length: count }, (_, i) => [
    "pointermove",
    {
      clientX: x0 + i * step,
      clientY: 0,
      timeStamp: t0 + i * dt,
      pointerType: "mouse",
      isTrusted: true,
    },
  ]);
}

/** Saltos imposibles cada 8 pasos (perfil IA franco): puntaje ~0.85. */
function teleportMoves(count: number, t0 = 0, dt = 60): Emission[] {
  return Array.from({ length: count }, (_, i) => [
    "pointermove",
    {
      clientX: 10 * i + (i % 8 === 0 ? 300 : 0),
      clientY: 0,
      timeStamp: t0 + i * dt,
      pointerType: "mouse",
      isTrusted: true,
    },
  ]);
}

/** Movimientos irregulares con correcciones (perfil humano): puntaje bajo. */
function humanMoves(count: number, t0 = 0): Emission[] {
  const out: Emission[] = [];
  let x = 0.5;
  let y = 0;
  let t = t0;
  for (let i = 0; i < count; i += 1) {
    const dt = 35 + ((i * 37) % 130) + (i % 7 === 3 ? 200 : 0);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    const dy = ((i * 5) % 7) - 3 + 0.2;
    if (i % 5 === 2) x -= dx * 0.8;
    else x += dx;
    y += dy;
    t += dt;
    out.push([
      "pointermove",
      { clientX: x, clientY: y, timeStamp: t, pointerType: "mouse", isTrusted: true },
    ]);
  }
  return out;
}

function botClicks(count: number, t0 = 0): Emission[] {
  const out: Emission[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = t0 + i * 100;
    const point = { clientX: 500.5, clientY: 300.25, button: 0, isTrusted: true };
    out.push(["pointerdown", { ...point, timeStamp: base }]);
    out.push(["pointerup", { ...point, timeStamp: base + 60 }]);
  }
  return out;
}

function botWheels(count: number, t0 = 0): Emission[] {
  return Array.from({ length: count }, (_, i) => [
    "wheel",
    { deltaX: 0, deltaY: 100, deltaMode: 0, timeStamp: t0 + i * 60, isTrusted: true },
  ]);
}

function botKeys(count: number, t0 = 0): Emission[] {
  const out: Emission[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = t0 + i * 200;
    out.push(["keydown", { code: "KeyA", key: "a", timeStamp: base, isTrusted: true }]);
    out.push(["keyup", { code: "KeyA", key: "a", timeStamp: base + 100, isTrusted: true }]);
  }
  return out;
}

function fakeDom(): { win: TestTarget; doc: TestTarget; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const win = new TestTarget();
  const doc = new TestTarget();
  globals.window = win;
  globals.document = doc;
  return {
    win,
    doc,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    },
  };
}

interface Session {
  detector: IsThatAnAI;
  target: TestTarget;
  clock: Clock;
  restore: () => void;
}

/** Sesión aislada con target inyectado: start() no consulta window/document. */
function session(options: DetectorOptions = {}): Session {
  const clock: Clock = { value: 0 };
  const target = new TestTarget();
  const detector = new IsThatAnAI({ ...options, now: () => clock.value });
  detector.attachTo(target);
  detector.start();
  return {
    detector,
    target,
    clock,
    restore: () => detector.stop(),
  };
}

/** Timer reemplazado: permite disparar ticks sin esperar 100 ms reales. */
function fakeTimers(): { fire: () => void; count: () => number; restore: () => void } {
  const globals = globalThis as unknown as {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  const originalSet = globals.setInterval;
  const originalClear = globals.clearInterval;
  const callbacks = new Map<number, () => void>();
  let next = 1;
  globals.setInterval = ((fn: () => void) => {
    const id = next++;
    callbacks.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globals.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    callbacks.delete(id as unknown as number);
  }) as typeof clearInterval;
  return {
    fire: () => {
      for (const fn of [...callbacks.values()]) fn();
    },
    count: () => callbacks.size,
    restore: () => {
      globals.setInterval = originalSet;
      globals.clearInterval = originalClear;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Defaults intactos
// ---------------------------------------------------------------------------

describe("Etapa 11 · defaults y formas públicas sin cambios", () => {
  it("estado inicial neutro, claves pinned y score calibrado idéntico", () => {
    const { detector, target, clock, restore } = session();
    try {
      expect(detector.getPaused()).toBe(false);
      expect(detector.isDebug()).toBe(false);
      expect(detector.getEnabledSignals()).toEqual([
        "mouse",
        "keyboard",
        "click",
        "scroll",
        "touch",
        "attention",
      ]);
      expect(Object.keys(detector.getConfig())).toEqual([
        "thresholds",
        "signalWeights",
        "device",
        "combination",
        "accessibilityProtection",
        "confirmMs",
        "emaAlpha",
      ]);
      expect(Object.keys(detector.getVerdict())).toEqual([
        "state",
        "score",
        "confidence",
        "doubt",
        "reasons",
      ]);

      emit(target, clock, botMoves(30));
      detector.evaluate();
      const samples = Array.from({ length: 30 }, (_, i) => ({
        seq: i + 1,
        x: i * 10,
        y: 0,
        t: i * 60,
        kind: 0 as const,
        pointerType: 0 as const,
        trusted: 1 as const,
      }));
      const expected = new ScoreComputer().evaluate(samples, 29 * 60).score;
      expect(detector.getVerdict().score).toBe(expected);
      expect(Object.keys(detector.getSignalScores())).toEqual(["mouse", "click", "scroll"]);
    } finally {
      restore();
    }
  });

  it("sin debug ni customEvent no se registra ni se despacha nada", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const dom = fakeDom();
    try {
      const detector = new IsThatAnAI();
      const seen: Event[] = [];
      dom.doc.addEventListener("isthatanai", (event) => seen.push(event));
      const target = new TestTarget();
      const clock: Clock = { value: 0 };
      detector.attachTo(target);
      detector.start();
      emit(target, clock, botMoves(30));
      detector.evaluate();
      expect(debugSpy).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      detector.stop();
    } finally {
      dom.restore();
      debugSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. pause / resume / getPaused
// ---------------------------------------------------------------------------

describe("Etapa 11 · pause y resume", () => {
  it("detiene el timer, mantiene colectores, calla y reanuda", () => {
    const timers = fakeTimers();
    const { detector, target, clock, restore } = session();
    try {
      expect(timers.count()).toBe(1);
      const states: string[] = [];
      detector.onVerdict((verdict) => states.push(verdict.state));

      emit(target, clock, botMoves(30));
      detector.pause();
      expect(detector.getPaused()).toBe(true);
      expect(timers.count()).toBe(0);
      detector.pause(); // idempotente
      expect(timers.count()).toBe(0);

      // Los colectores siguen adjuntos.
      emit(target, clock, botMoves(10, 2000, 60, 10, 100));
      expect(detector.getStats().sampleCount).toBe(40);

      // Ni evaluate() manual ni un tick pueden emitir durante la pausa.
      detector.evaluate();
      timers.fire();
      expect(states).toEqual([]);
      expect(detector.getVerdict().state).toBe("measuring");
      expect(detector.getVerdict().score).toBeNull();

      detector.resume();
      detector.resume(); // idempotente
      expect(detector.getPaused()).toBe(false);
      expect(timers.count()).toBe(1);

      emit(target, clock, teleportMoves(30, 4000));
      timers.fire();
      expect(detector.getVerdict().score).not.toBeNull();
      // Primera evaluación con score alto: histeresis aún pendiente.
      expect(detector.getVerdict().state).toBe("measuring");
      emit(target, clock, teleportMoves(30, 8000));
      timers.fire();
      expect(detector.getVerdict().state).toBe("ai");
      expect(states).toContain("ai");

      detector.stop();
      expect(timers.count()).toBe(0);
    } finally {
      restore();
      timers.restore();
    }
  });

  it("pausar antes de start() no crea timer; resume() tras start() lo crea", () => {
    const timers = fakeTimers();
    const target = new TestTarget();
    const clock: Clock = { value: 0 };
    const detector = new IsThatAnAI({ now: () => clock.value });
    try {
      detector.pause();
      detector.attachTo(target);
      detector.start();
      expect(timers.count()).toBe(0);
      detector.resume();
      expect(timers.count()).toBe(1);
      detector.stop();
      expect(timers.count()).toBe(0);
    } finally {
      timers.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. onThreshold
// ---------------------------------------------------------------------------

describe("Etapa 11 · onThreshold", () => {
  it("cruza en ambos sentidos, incluye null↔número y respeta unsubscribe", () => {
    const { detector, target, clock, restore } = session({
      mouse: { maxAgeMs: 3000 },
      signals: ["mouse"],
    });
    detector.configure({ emaAlpha: 1 });
    const seen: Array<number | null> = [];
    const off = detector.onThreshold(0.5, (score) => seen.push(score));
    try {
      // null -> número por debajo del umbral.
      emit(target, clock, humanMoves(30));
      detector.evaluate();
      const low = detector.getVerdict().score as number;
      expect(low).toBeLessThan(0.5);
      expect(seen).toEqual([low]);

      // abajo -> arriba.
      emit(target, clock, teleportMoves(30, 6000));
      detector.evaluate();
      const high = detector.getVerdict().score as number;
      expect(high).toBeGreaterThan(0.5);
      expect(seen).toEqual([low, high]);

      // Mismo lado: no dispara.
      emit(target, clock, teleportMoves(30, 12000));
      detector.evaluate();
      expect(seen).toEqual([low, high]);

      // Baja de nuevo y unsubscribe: no dispara más.
      off();
      emit(target, clock, humanMoves(30, 18000));
      detector.evaluate();
      expect(seen).toEqual([low, high]);
      off(); // idempotente

      // Número -> null al envejecer TODA la evidencia (otra suscripción).
      const late: Array<number | null> = [];
      const off2 = detector.onThreshold(0.5, (score) => late.push(score));
      clock.value = 60000;
      detector.evaluate();
      expect(late).toEqual([null]);
      off2();
    } finally {
      restore();
    }
  });

  it("valida el valor: fuera de [0,1] o no finito usa 0.5; callback inválido es no-op", () => {
    const { detector, target, clock, restore } = session();
    detector.configure({ emaAlpha: 1 });
    const seen: number[] = [];
    const offA = detector.onThreshold(-1, (score) => {
      if (score !== null) seen.push(score);
    });
    const offB = detector.onThreshold(2, (score) => {
      if (score !== null) seen.push(score);
    });
    const offC = detector.onThreshold(Number.NaN, (score) => {
      if (score !== null) seen.push(score);
    });
    const noop = detector.onThreshold(0.5, undefined as unknown as (s: number | null) => void);
    try {
      emit(target, clock, humanMoves(30));
      detector.evaluate();
      const low = detector.getVerdict().score as number;
      expect(low).toBeLessThan(0.5);
      expect(seen).toEqual([low, low, low]);
      noop();
    } finally {
      offA();
      offB();
      offC();
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. enableSignals / disableSignals / getEnabledSignals
// ---------------------------------------------------------------------------

describe("Etapa 11 · enableSignals / disableSignals", () => {
  it("cada señal puntuable puede desactivarse y reactivarse", () => {
    const scenarios: Array<{
      signal: Signal;
      events: Emission[];
      key: "mouse" | "click" | "scroll" | "keyboard";
    }> = [
      { signal: "mouse", events: botMoves(30), key: "mouse" },
      { signal: "click", events: botClicks(10), key: "click" },
      { signal: "scroll", events: botWheels(10), key: "scroll" },
      { signal: "keyboard", events: botKeys(24), key: "keyboard" },
    ];

    for (const { signal, events, key } of scenarios) {
      const { detector, target, clock, restore } = session({ signals: [signal] });
      detector.configure({ emaAlpha: 1 });
      try {
        emit(target, clock, events);
        detector.evaluate();
        expect(detector.getVerdict().score).not.toBeNull();
        const withSignal = detector.getVerdict().reasons;
        expect(detector.getSignalScores()[key]).not.toBeNull();

        detector.disableSignals([signal]);
        expect(detector.getEnabledSignals()).not.toContain(signal);
        detector.evaluate();
        expect(detector.getVerdict().score).toBeNull();
        expect(detector.getSignalScores()[key]).toBeNull();
        for (const reason of withSignal) {
          expect(detector.getVerdict().reasons).not.toContain(reason);
        }

        detector.enableSignals([signal]);
        expect(detector.getEnabledSignals()).toContain(signal);
        detector.evaluate();
        expect(detector.getVerdict().score).not.toBeNull();
      } finally {
        restore();
      }
    }
  });

  it("desactivar una señal excluye su aporte de la combinación y del breakdown", () => {
    const { detector, target, clock, restore } = session();
    detector.configure({ emaAlpha: 1 });
    try {
      const events = [...botMoves(30), ...botClicks(10, 3000)];
      emit(target, clock, events);
      detector.evaluate();
      const combined = detector.getVerdict().score as number;
      expect(detector.getSignalScores().click).not.toBeNull();

      detector.disableSignals(["click"]);
      detector.evaluate();
      const withoutClick = detector.getVerdict().score as number;
      expect(withoutClick).not.toBe(combined);
      expect(detector.getSignalScores().click).toBeNull();
      expect(detector.getScoreBreakdown().scores.click).toBeNull();

      detector.enableSignals(["click"]);
      detector.evaluate();
      expect(detector.getVerdict().score).toBe(combined);
    } finally {
      restore();
    }
  });

  it("nombres inválidos se ignoran; signals:[] no puntúa", () => {
    const first = session({ signals: ["bogus" as Signal] });
    try {
      emit(first.target, first.clock, botMoves(30));
      first.detector.evaluate();
      expect(first.detector.getVerdict().score).toBeNull();
      first.detector.enableSignals(["nope" as Signal]);
      expect(first.detector.getEnabledSignals()).toEqual([]);
      first.detector.disableSignals(["nope" as Signal]);
      expect(first.detector.getEnabledSignals()).toEqual([]);
    } finally {
      first.restore();
    }

    const second = session();
    try {
      const before = second.detector.getEnabledSignals();
      second.detector.enableSignals(["nope" as Signal, "click"]);
      second.detector.disableSignals(["nope" as Signal]);
      expect(second.detector.getEnabledSignals()).toEqual(before);
      expect(second.detector.getEnabledSignals()).toContain("touch");
    } finally {
      second.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Debug mode
// ---------------------------------------------------------------------------

describe("Etapa 11 · debug", () => {
  it("setDebug/isDebug registran solo dentro de evaluate()", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const { detector, target, clock, restore } = session();
    try {
      detector.setDebug(true);
      expect(detector.isDebug()).toBe(true);
      expect(debugSpy).not.toHaveBeenCalled();
      emit(target, clock, botMoves(30));
      detector.evaluate();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const line = String(debugSpy.mock.calls[0][0]);
      expect(line).toContain("state=");
      expect(line).toContain("score=");

      detector.setDebug(false);
      debugSpy.mockClear();
      emit(target, clock, botMoves(10, 3000));
      detector.evaluate();
      expect(debugSpy).not.toHaveBeenCalled();

      detector.setDebug("si" as unknown as boolean); // hostil: se ignora
      expect(detector.isDebug()).toBe(false);
    } finally {
      restore();
      debugSpy.mockRestore();
    }
  });

  it("la opción debug no registra al construir ni al arrancar", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const detector = new IsThatAnAI({ debug: true });
    try {
      expect(detector.isDebug()).toBe(true);
      expect(debugSpy).not.toHaveBeenCalled();
      detector.start();
      expect(debugSpy).not.toHaveBeenCalled();
      detector.evaluate(); // sin colector: tampoco registra
      expect(debugSpy).not.toHaveBeenCalled();
      detector.stop();
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. CustomEvent
// ---------------------------------------------------------------------------

describe("Etapa 11 · customEvent", () => {
  it("despacha CustomEvent('isthatanai') con una copia del veredicto al cambiar", () => {
    const dom = fakeDom();
    const clock: Clock = { value: 0 };
    const target = new TestTarget();
    const seen: CustomEvent[] = [];
    dom.doc.addEventListener("isthatanai", (event) => seen.push(event as CustomEvent));
    const detector = new IsThatAnAI({ customEvent: true, now: () => clock.value });
    detector.attachTo(target);
    detector.start();
    try {
      emit(target, clock, teleportMoves(30));
      detector.evaluate();
      expect(seen).toHaveLength(0); // primera evaluación: histeresis pendiente

      emit(target, clock, teleportMoves(30, 4000));
      detector.evaluate();
      expect(seen).toHaveLength(1); // measuring -> ai
      expect(seen[0].type).toBe("isthatanai");
      const detail = seen[0].detail as {
        state: string;
        score: number | null;
        confidence: number;
        doubt: number;
        reasons: string[];
      };
      expect(detail.state).toBe("ai");
      expect(detail.score).toBe(detector.getVerdict().score);
      expect(Object.keys(detail)).toEqual(["state", "score", "confidence", "doubt", "reasons"]);

      detail.reasons.push("mutado");
      expect(detector.getVerdict().reasons).not.toContain("mutado");

      detector.evaluate(); // mismo estado: no despacha de nuevo
      expect(seen).toHaveLength(1);
    } finally {
      detector.stop();
      dom.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. autoStart
// ---------------------------------------------------------------------------

describe("Etapa 11 · autoStart", () => {
  it("devuelve null sin document (SSR)", () => {
    const globals = globalThis as unknown as { document?: unknown };
    const previous = globals.document;
    Reflect.deleteProperty(globals, "document");
    try {
      expect(autoStart()).toBeNull();
    } finally {
      if (previous === undefined) delete globals.document;
      else globals.document = previous;
    }
  });

  it("con DOM construye y arranca el detector", () => {
    const dom = fakeDom();
    const detector = autoStart();
    try {
      expect(detector).not.toBeNull();
      expect(detector?.getPaused()).toBe(false);
      const clock: Clock = { value: 0 };
      emit(dom.win, clock, botMoves(30));
      detector?.evaluate();
      expect(detector?.getVerdict().score).not.toBeNull();
    } finally {
      detector?.stop();
      dom.restore();
    }
  });

  it("la opción autoStart por sí sola no arranca: el constructor sigue siendo SSR-safe", () => {
    const detector = new IsThatAnAI({ autoStart: true });
    try {
      detector.evaluate();
      expect(detector.getVerdict()).toEqual({
        state: "measuring",
        score: null,
        confidence: 0,
        doubt: 1,
        reasons: [],
      });
    } finally {
      detector.stop();
    }
  });
});
