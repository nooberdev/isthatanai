// Auditoría "mundo real" de los ítems L159–L208 del checklist más el contrato
// de grabación/recalibración (L219/L220 en la librería). Harness end-to-end con
// DOM falso y reloj inyectado: sesión de navegación humana, bot naive y agente
// humanizado. Sin red, sin almacenamiento, sin deps nuevas.

import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { autoStart } from "../../src/auto-start";
import { type CalibrationSession, calibrationFromSession } from "../../src/calibration/recalibrate";
import { IsThatAnAI } from "../../src/core/detector";
import { extractMouseFeatures } from "../../src/features/mouse";
import { createDetectorHandle, createReactDetector } from "../../src/frameworks/react";
import { createSvelteDetector } from "../../src/frameworks/svelte";
import { createVueDetector } from "../../src/frameworks/vue";
import { DEFAULT_GLOBAL_NAME, installGlobal } from "../../src/global";
import { LOCALES, t } from "../../src/i18n";
import { translateReasons } from "../../src/i18n/reason-translator";
import {
  AI_MIN,
  computeScore,
  EMA_ALPHA,
  HUMAN_MAX,
  ScoreComputer,
  SENSITIVITY_PRESETS,
} from "../../src/scoring/score";
import type { DetectorOptions, Verdict } from "../../src/types";
import { PRIVACY_NOTICE, privacyAudit } from "../../src/utils/privacy-audit";
import { roundTiming } from "../../src/utils/privacy-shape";

// ---------------------------------------------------------------------------
// Harness: DOM falso + reloj inyectado
// ---------------------------------------------------------------------------

/** EventTarget mínimo que entrega objetos planos (permite fijar isTrusted). */
class FakeTarget implements EventTarget {
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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type Emission = [type: string, props: Record<string, unknown>];
type Clock = { value: number };

function emit(target: FakeTarget, clock: Clock, events: Emission[]): void {
  for (const [type, props] of events) {
    const ts = props.timeStamp;
    if (typeof ts === "number" && Number.isFinite(ts)) clock.value = ts;
    target.emit(type, props);
  }
}

/** PRNG determinista: los "humanos" son irregulares pero reproducibles. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Usuario navegando: mouse curvo/subpíxel, clics dispersos, scroll con
 *  cambios de dirección y pausas, y tecleo de un párrafo con errores. */
function humanBrowsing(t0 = 0): Emission[] {
  const r = rng(7);
  const out: Emission[] = [];
  let t = t0;
  let x = 120.3;
  let y = 80.7;
  for (let i = 0; i < 60; i += 1) {
    t += 22 + Math.floor(r() * 90) + (i % 11 === 5 ? 160 : 0);
    const dx = 4 + r() * 11 + 0.3;
    const dy = (r() - 0.5) * 9 + 0.2;
    if (i % 7 === 4) {
      x -= dx * 0.7;
      y -= dy * 0.5;
    } else {
      x += dx;
      y += dy;
    }
    out.push([
      "pointermove",
      { clientX: x, clientY: y, timeStamp: t, pointerType: "mouse", isTrusted: true },
    ]);
  }
  for (let i = 0; i < 7; i += 1) {
    t += 180 + Math.floor(r() * 500);
    const cx = 300 + r() * 40;
    const cy = 200 + r() * 30;
    out.push([
      "pointerdown",
      { clientX: cx, clientY: cy, button: 0, timeStamp: t, pointerType: "mouse", isTrusted: true },
    ]);
    out.push([
      "pointerup",
      {
        clientX: cx + 0.8,
        clientY: cy - 0.4,
        button: 0,
        timeStamp: t + 80 + Math.floor(r() * 90),
        pointerType: "mouse",
        isTrusted: true,
      },
    ]);
  }
  for (let i = 0; i < 16; i += 1) {
    t += 60 + Math.floor(r() * 220);
    out.push([
      "wheel",
      {
        deltaX: 0,
        deltaY: i === 10 ? -40 : 40 + Math.floor(r() * 70),
        deltaMode: 0,
        timeStamp: t,
        isTrusted: true,
      },
    ]);
  }
  t += 700;
  const codes = [
    "KeyT",
    "KeyH",
    "KeyE",
    "Space",
    "KeyQ",
    "KeyU",
    "KeyI",
    "KeyC",
    "KeyK",
    "Space",
    "KeyB",
    "KeyR",
    "KeyO",
    "KeyW",
    "KeyN",
    "Space",
    "KeyF",
    "KeyO",
    "KeyX",
    "Space",
  ];
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    const hold = 55 + Math.floor(r() * 60);
    out.push([
      "keydown",
      {
        code,
        key: code === "Space" ? " " : code.slice(-1).toLowerCase(),
        timeStamp: t,
        isTrusted: true,
      },
    ]);
    out.push(["keyup", { code, timeStamp: t + hold, isTrusted: true }]);
    t += hold + 20 + Math.floor(r() * 130) + (code === "Space" ? 120 : 0);
    if (i === 12) {
      out.push(["keydown", { code: "Backspace", key: "Backspace", timeStamp: t, isTrusted: true }]);
      out.push(["keyup", { code: "Backspace", timeStamp: t + 70, isTrusted: true }]);
      t += 260 + Math.floor(r() * 200);
    }
  }
  return out;
}

/** Bot naive: recto, métronómico, sin errores, clics en el mismo punto. */
function naiveBot(t0 = 0): Emission[] {
  const out: Emission[] = [];
  let t = t0;
  for (let i = 0; i < 60; i += 1) {
    t += 40;
    out.push([
      "pointermove",
      { clientX: i * 10, clientY: i * 10, timeStamp: t, pointerType: "mouse", isTrusted: true },
    ]);
  }
  for (let i = 0; i < 7; i += 1) {
    const base = t + i * 200;
    out.push([
      "pointerdown",
      { clientX: 500, clientY: 300, button: 0, timeStamp: base, isTrusted: true },
    ]);
    out.push([
      "pointerup",
      { clientX: 500, clientY: 300, button: 0, timeStamp: base + 50, isTrusted: true },
    ]);
  }
  for (let i = 0; i < 16; i += 1) {
    t += 100;
    out.push(["wheel", { deltaX: 0, deltaY: 100, deltaMode: 0, timeStamp: t, isTrusted: true }]);
  }
  for (let i = 0; i < 24; i += 1) {
    const base = t + i * 100;
    out.push(["keydown", { code: "KeyA", key: "a", timeStamp: base, isTrusted: true }]);
    out.push(["keyup", { code: "KeyA", timeStamp: base + 50, isTrusted: true }]);
  }
  return out;
}

/** Agente humanizado: patrón de bot + ruido uniforme en tiempo y coordenadas. */
function humanizedAgent(t0 = 0): Emission[] {
  const r = rng(99);
  const out: Emission[] = [];
  let t = t0;
  for (let i = 0; i < 60; i += 1) {
    t += 40 + (r() - 0.5) * 8;
    out.push([
      "pointermove",
      {
        clientX: i * 10 + (r() - 0.5) * 6,
        clientY: i * 10 + (r() - 0.5) * 6,
        timeStamp: t,
        pointerType: "mouse",
        isTrusted: true,
      },
    ]);
  }
  for (let i = 0; i < 7; i += 1) {
    const base = t + i * 200 + (r() - 0.5) * 20;
    out.push([
      "pointerdown",
      { clientX: 500 + (r() - 0.5) * 8, clientY: 300, button: 0, timeStamp: base, isTrusted: true },
    ]);
    out.push([
      "pointerup",
      {
        clientX: 500 + (r() - 0.5) * 8,
        clientY: 300,
        button: 0,
        timeStamp: base + 50 + (r() - 0.5) * 10,
        isTrusted: true,
      },
    ]);
  }
  for (let i = 0; i < 16; i += 1) {
    t += 100 + (r() - 0.5) * 20;
    out.push([
      "wheel",
      { deltaX: 0, deltaY: 100 + (r() - 0.5) * 10, deltaMode: 0, timeStamp: t, isTrusted: true },
    ]);
  }
  for (let i = 0; i < 24; i += 1) {
    const base = t + i * 100 + (r() - 0.5) * 12;
    out.push(["keydown", { code: "KeyA", key: "a", timeStamp: base, isTrusted: true }]);
    out.push(["keyup", { code: "KeyA", timeStamp: base + 50 + (r() - 0.5) * 10, isTrusted: true }]);
  }
  return out;
}

type Kind = "human" | "bot" | "agent";

/** Toma de control por un bot: saltos imposibles sostenidos durante > maxAge. */
function botTakeover(target: FakeTarget, clock: Clock, startT: number): void {
  for (let chunk = 0; chunk < 6; chunk += 1) {
    const events: Emission[] = [];
    for (let i = 0; i < 12; i += 1) {
      const n = chunk * 12 + i;
      events.push([
        "pointermove",
        {
          clientX: n * 10 + (n % 8 === 0 ? 300 : 0),
          clientY: 0,
          timeStamp: startT + n * 200,
          pointerType: "mouse",
          isTrusted: true,
        },
      ]);
    }
    emit(target, clock, events);
  }
}

/** Continuación de la misma conducta para que la histeresis pueda confirmar. */
function confirmTail(kind: Kind, events: Emission[]): Emission[] {
  const last = events.length > 0 ? (events[events.length - 1][1].timeStamp as number) : 0;
  const r = rng(kind === "human" ? 3 : kind === "bot" ? 4 : 5);
  const tail: Emission[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const jitter = kind === "human" ? (r() - 0.5) * 20 : kind === "agent" ? (r() - 0.5) * 6 : 0;
    tail.push([
      "pointermove",
      {
        clientX: 700 + i * 8 + jitter,
        clientY: 500 + (kind === "human" ? jitter : 0),
        timeStamp: last + i * 100,
        pointerType: "mouse",
        isTrusted: true,
      },
    ]);
  }
  return tail;
}

interface Session {
  detector: IsThatAnAI;
  target: FakeTarget;
  clock: Clock;
  verdicts: Verdict[];
  changes: Array<"human" | "ai">;
  thresholds: Array<number | null>;
  finish: () => void;
}

/** Corre una sesión real completa: start → eventos → evaluate → stop. */
function runSession(
  kind: Kind,
  options: DetectorOptions = {},
  hooks: {
    onVerdict?: (v: Verdict) => void;
    onChange?: (s: "human" | "ai") => void;
    onThreshold?: number;
    configure?: (d: IsThatAnAI) => void;
    autoEvaluate?: boolean;
  } = {},
): Session {
  const clock: Clock = { value: 0 };
  const target = new FakeTarget();
  const detector = new IsThatAnAI({ ...options, now: () => clock.value });
  const verdicts: Verdict[] = [];
  const changes: Array<"human" | "ai"> = [];
  const thresholds: Array<number | null> = [];
  detector.onVerdict((v) => {
    verdicts.push({ ...v, reasons: [...v.reasons] });
    hooks.onVerdict?.(v);
  });
  detector.onChange((s) => {
    changes.push(s);
    hooks.onChange?.(s);
  });
  if (hooks.onThreshold !== undefined) {
    detector.onThreshold(hooks.onThreshold, (score) => thresholds.push(score));
  }
  detector.attachTo(target);
  detector.start();
  hooks.configure?.(detector);

  const base = kind === "human" ? humanBrowsing() : kind === "bot" ? naiveBot() : humanizedAgent();
  const events = [...base, ...confirmTail(kind, base)];
  for (let i = 0; i < events.length; i += 10) {
    emit(target, clock, events.slice(i, i + 10));
    if (hooks.autoEvaluate !== false) detector.evaluate();
  }
  detector.evaluate();
  return { detector, target, clock, verdicts, changes, thresholds, finish: () => detector.stop() };
}

function runAll(
  fn: (s: Session) => void,
  kind: Kind = "human",
  options: DetectorOptions = {},
): void {
  const s = runSession(kind, options);
  try {
    fn(s);
  } finally {
    s.finish();
  }
}

function fakeDom(): { win: FakeTarget; doc: FakeTarget; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWin = globals.window;
  const prevDoc = globals.document;
  const win = new FakeTarget();
  const doc = new FakeTarget();
  globals.window = win;
  globals.document = doc;
  return {
    win,
    doc,
    restore: () => {
      if (prevWin === undefined) delete globals.window;
      else globals.window = prevWin;
      if (prevDoc === undefined) delete globals.document;
      else globals.document = prevDoc;
    },
  };
}

function inUnit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

// ===========================================================================
// MOTOR DE PUNTAJE (L159–L175)
// ===========================================================================

describe("L159 · puntaje 0..1 (humano → IA)", () => {
  it("sesión humana y bot naive producen scores finitos en [0,1] y ordenados", () => {
    const scores: number[] = [];
    for (const kind of ["human", "bot", "agent"] as Kind[]) {
      runAll(({ detector }) => {
        const v = detector.getVerdict();
        expect(v.score).not.toBeNull();
        expect(inUnit(v.score)).toBe(true);
        scores.push(v.score as number);
      }, kind);
    }
    expect(scores[1]).toBeGreaterThan(scores[0]);
  });
});

describe("L160 · nivel de confianza", () => {
  it("la confianza crece con la evidencia y nunca sale de [0,1]", () => {
    runAll(({ detector }) => {
      const v = detector.getVerdict();
      expect(inUnit(v.confidence)).toBe(true);
      expect(v.confidence).toBeGreaterThan(0);
      expect(detector.getScoreBreakdown().ema.alpha).toBe(EMA_ALPHA);
    }, "bot");
    const computer = new ScoreComputer();
    expect(computer.evaluate([], 0).confidence).toBe(0);
  });
});

describe("L161 · razones legibles", () => {
  it("las razones son cadenas no vacías derivadas de la sesión", () => {
    runAll(({ detector }) => {
      const reasons = detector.getReasons();
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(typeof reason).toBe("string");
        expect(reason.length).toBeGreaterThan(2);
      }
    }, "bot");
  });
});

describe("L162 · puntaje por señal", () => {
  it("getSignalScores y el breakdown exponen mouse/click/scroll y teclado no enumerable", () => {
    runAll(({ detector }) => {
      const scores = detector.getSignalScores();
      expect(Object.keys(scores)).toEqual(["mouse", "click", "scroll"]);
      expect(inUnit(scores.mouse as number)).toBe(true);
      expect(inUnit(scores.click as number)).toBe(true);
      expect(inUnit(scores.scroll as number)).toBe(true);
      expect(typeof scores.keyboard).toBe("number");
      expect(detector.getScoreBreakdown().scores).toEqual(scores);
    }, "bot");
  });
});

describe("L163 · pesos configurables por señal", () => {
  it("configure(signalWeights) altera breakdown y el score combinado", () => {
    const read = (weights: Record<string, number>): number => {
      const clock: Clock = { value: 0 };
      const target = new FakeTarget();
      const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 1e6 } });
      d.attachTo(target);
      d.start();
      d.configure({ signalWeights: weights });
      emit(target, clock, naiveBot());
      d.evaluate();
      const score = d.getVerdict().score;
      d.stop();
      return score as number;
    };
    const base = read({ mouse: 0.6, click: 0.2, scroll: 0.2, keyboard: 0.15 });
    const mouseOnly = read({ mouse: 1, click: 0, scroll: 0, keyboard: 0 });
    expect(base).not.toBe(mouseOnly);
  });
});

describe("L164 · combinación inteligente (adaptive)", () => {
  it("adaptive reweights señales difíciles de falsificar y weighted queda intacto", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(target);
    d.start();
    expect(d.getScoreBreakdown().effectiveWeights).toEqual({
      mouse: 0.6,
      click: 0.2,
      scroll: 0.2,
      keyboard: 0.15,
    });
    d.configure({ combination: "adaptive" });
    const ew = d.getScoreBreakdown().effectiveWeights;
    expect(ew.mouse).toBeGreaterThan(0.6);
    expect(ew.keyboard).toBeGreaterThan(0.15);
    expect(ew.click).toBeLessThan(0.2);
    expect(ew.scroll).toBeLessThan(0.2);
    d.stop();
  });
});

describe("L165 · ventana deslizante (solo reciente)", () => {
  it("evidencia antigua se descarta por maxAgeMs", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 3000 } });
    d.attachTo(target);
    d.start();
    const old = naiveBot(0).slice(0, 30);
    emit(target, clock, old);
    expect(d.getStats().sampleCount).toBeGreaterThan(0);
    clock.value = 100000;
    d.evaluate();
    expect(d.getStats().sampleCount).toBe(0);
    expect(d.getVerdict().score).toBeNull();
    d.stop();
  });
});

describe("L166 · memoria corta (veredicto en tiempo real)", () => {
  it("humano convincente cambia a IA cuando el control lo toma un bot", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 6000 } });
    d.attachTo(target);
    d.start();
    d.configure({ emaAlpha: 1 });
    const humanPhase = humanBrowsing();
    for (let i = 0; i < humanPhase.length; i += 10) {
      emit(target, clock, humanPhase.slice(i, i + 10));
      d.evaluate();
    }
    expect(d.getVerdict().state).toBe("human");
    const last = humanPhase[humanPhase.length - 1][1].timeStamp as number;
    // Un bot toma el control: saltos imposibles sostenidos hasta desplazar la
    // evidencia humana de la ventana deslizante.
    for (let chunk = 0; chunk < 6; chunk += 1) {
      const events: Emission[] = [];
      for (let i = 0; i < 12; i += 1) {
        const n = chunk * 12 + i;
        events.push([
          "pointermove",
          {
            clientX: n * 10 + (n % 8 === 0 ? 300 : 0),
            clientY: 0,
            timeStamp: last + 100 + n * 200,
            pointerType: "mouse",
            isTrusted: true,
          },
        ]);
      }
      emit(target, clock, events);
      d.evaluate();
    }
    expect(d.getVerdict().score).toBeGreaterThanOrEqual(AI_MIN);
    expect(d.getVerdict().state).toBe("ai");
    d.stop();
  });
});

describe("L167 · 'aún no sé' con pocos datos", () => {
  it("sin muestras el veredicto es measuring con score null", () => {
    // Sin eventos: sesión vacía explícita.
    const d = new IsThatAnAI({ now: () => 0 });
    d.attachTo(new FakeTarget());
    d.start();
    d.evaluate();
    expect(d.getVerdict().state).toBe("measuring");
    d.stop();
  });
});

describe("L168 · mínimo de evidencia", () => {
  it("10 movimientos son suficientes; 5 no", () => {
    const five = new ScoreComputer().evaluate(
      Array.from({ length: 5 }, (_, i) => ({
        seq: i + 1,
        x: i * 10,
        y: 0,
        t: i * 60,
        kind: 0 as const,
        pointerType: 0 as const,
        trusted: 1 as const,
      })),
      5 * 60,
    );
    expect(five.score).toBeNull();
    runAll(({ detector }) => {
      expect(detector.getVerdict().score).not.toBeNull();
    }, "bot");
  });
});

describe("L169 · suavizado EMA", () => {
  it("el score se suaviza entre evaluaciones con alpha documentado", () => {
    const c = new ScoreComputer();
    const humanSamples = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      x: i * 6 + 0.3 * i,
      y: (i % 5) * 2.2,
      t: i * 60,
      kind: 0 as const,
      pointerType: 0 as const,
      trusted: 1 as const,
    }));
    const botSamples = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 31,
      x: i * 10 + (i % 8 === 0 ? 300 : 0),
      y: 0,
      t: 2000 + i * 60,
      kind: 0 as const,
      pointerType: 0 as const,
      trusted: 1 as const,
    }));
    const first = c.evaluate(humanSamples, 29 * 60);
    const rawSecond = computeScore(extractMouseFeatures(botSamples));
    const second = c.evaluate(botSamples, 29 * 60);
    expect(second.score).toBeCloseTo(
      EMA_ALPHA * rawSecond + (1 - EMA_ALPHA) * (first.score as number),
      6,
    );
  });
});

describe("L170 · detección de cambio de controlador", () => {
  it("humano → bot deja rastro en el breakdown sin forzar el veredicto", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 6000 } });
    d.attachTo(target);
    d.start();
    d.configure({ emaAlpha: 1 });
    const feed = (events: Emission[]): void => {
      for (let i = 0; i < events.length; i += 10) {
        emit(target, clock, events.slice(i, i + 10));
        d.evaluate();
      }
    };
    const human = humanBrowsing();
    feed(human);
    expect(d.getVerdict().state).toBe("human");
    expect(d.getScoreBreakdown().handover).toBeNull();
    const last = human[human.length - 1][1].timeStamp as number;
    const bot: Emission[] = [];
    for (let chunk = 0; chunk < 6; chunk += 1) {
      for (let i = 0; i < 12; i += 1) {
        const n = chunk * 12 + i;
        bot.push([
          "pointermove",
          {
            clientX: n * 10 + (n % 8 === 0 ? 300 : 0),
            clientY: 0,
            timeStamp: last + 100 + n * 200,
            pointerType: "mouse",
            isTrusted: true,
          },
        ]);
      }
    }
    feed(bot);
    expect(d.getVerdict().state).toBe("ai");
    const b = d.getScoreBreakdown();
    expect(b.handover).not.toBeNull();
    expect(b.handover?.from).toBe("human");
    expect(b.handover?.to).toBe("ai");
    expect(b.handoverCount).toBeGreaterThanOrEqual(1);
    d.stop();
  });
});

describe("L171 · protección contra falsos positivos (accesibilidad)", () => {
  it("perfil touch atenúa el score pero nunca crea evidencia", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, detailedDevice: "tablet" });
    d.attachTo(target);
    d.start();
    d.configure({ accessibilityProtection: true });
    const samples = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      x: i * 10 + (i % 8 === 0 ? 300 : 0),
      y: 0,
      t: i * 60,
      pointerType: 2 as const,
      trusted: 1 as const,
      kind: 0 as const,
    }));
    emit(
      target,
      clock,
      samples.map(
        (s) =>
          [
            "pointermove",
            { clientX: s.x, clientY: s.y, timeStamp: s.t, pointerType: "touch", isTrusted: true },
          ] as Emission,
      ),
    );
    d.evaluate();
    const score = d.getVerdict().score as number;
    expect(inUnit(score)).toBe(true);
    expect(d.getScoreBreakdown().accessibility.applied).toBe(true);
    d.stop();
  });
});

describe("L172 · modo accesibilidad (teclado/lector)", () => {
  it("pointer no confiable se ignora; el teclado sigue puntuando", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, accessibility: true });
    d.attachTo(target);
    d.start();
    const keys: Emission[] = [];
    for (let i = 0; i < 24; i += 1) {
      const base = i * 100;
      keys.push(["keydown", { code: "KeyA", timeStamp: base, isTrusted: true }]);
      keys.push(["keyup", { code: "KeyA", timeStamp: base + 50, isTrusted: true }]);
    }
    emit(target, clock, keys);
    d.evaluate();
    expect(d.getVerdict().score).not.toBeNull();
    expect(d.getSignalScores().keyboard).not.toBeNull();
    expect(d.getSignalScores().mouse).toBeNull();
    d.stop();
  });
});

describe("L173 · modo sensibilidad (estricto/normal/relajado)", () => {
  it("los presets cambian umbrales y tiempos de confirmación reales", () => {
    const d = new IsThatAnAI();
    d.configure({ sensitivity: "estricto" });
    expect(d.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.estricto.thresholds);
    expect(d.getConfig().confirmMs).toEqual(SENSITIVITY_PRESETS.estricto.confirmMs);
    d.configure({ sensitivity: "relajado" });
    expect(d.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.relajado.thresholds);
    expect(d.getConfig().confirmMs).toEqual(SENSITIVITY_PRESETS.relajado.confirmMs);
    d.configure({ sensitivity: "normal" });
    expect(d.getConfig().thresholds).toEqual({ humanMax: HUMAN_MAX, aiMin: AI_MIN });
  });
});

describe("L174 · perfiles por tipo de dispositivo", () => {
  it("el perfil configurado gobierna getConfig/getDeviceProfile", () => {
    const d = new IsThatAnAI({ device: "tv", detailedDevice: "tv" });
    expect(d.getConfig().device).toBe("tv");
    expect(d.getDeviceProfile()).toBe("tv");
    expect(d.getDetailedDevice()).toBe("tv");
    d.configure({ device: "touch" });
    expect(d.getDeviceProfile()).toBe("touch");
  });
});

describe("L175 · umbrales configurables", () => {
  it("umbrales explícitos cambian la banda de decisión", () => {
    const d = new IsThatAnAI();
    d.configure({ thresholds: { humanMax: 0.3, aiMin: 0.7 } });
    expect(d.getConfig().thresholds).toEqual({ humanMax: 0.3, aiMin: 0.7 });
    // Solapados → default seguro histórico (fail closed).
    d.configure({ thresholds: { humanMax: 0.9, aiMin: 0.1 } });
    expect(d.getConfig().thresholds).toEqual({ humanMax: HUMAN_MAX, aiMin: AI_MIN });
  });
});

// ===========================================================================
// FUNCIONES DE LA LIBRERÍA (L176–L197)
// ===========================================================================

describe("L177 · start()", () => {
  it("engancha listeners y arranca el timer de evaluación", () => {
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => 0 });
    d.attachTo(target);
    d.start();
    expect(target.listenerCount("pointermove")).toBe(1);
    expect(target.listenerCount("keydown")).toBe(1);
    expect(d.getPaused()).toBe(false);
    d.stop();
  });
});

describe("L178 · stop()", () => {
  it("desengancha listeners, apaga el timer y borra el estado", () => {
    runAll(({ detector, target }) => {
      detector.stop();
      expect(target.listenerCount("pointermove")).toBe(0);
      expect(detector.getVerdict()).toEqual({
        state: "measuring",
        score: null,
        confidence: 0,
        doubt: 1,
        reasons: [],
      });
      expect(detector.getStats().sampleCount).toBe(0);
    }, "bot");
  });
});

describe("L179 · pause()/resume()", () => {
  it("pausa congela evaluaciones pero sigue acumulando muestras", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    const seen: string[] = [];
    d.onVerdict((v) => seen.push(v.state));
    d.attachTo(target);
    d.start();
    emit(target, clock, naiveBot().slice(0, 20));
    d.pause();
    d.evaluate();
    expect(seen).toEqual([]);
    emit(target, clock, naiveBot().slice(20, 30));
    expect(d.getStats().sampleCount).toBe(30);
    d.resume();
    d.evaluate();
    expect(d.getVerdict().score).not.toBeNull();
    d.stop();
  });
});

describe("L180 · getVerdict()", () => {
  it("devuelve una copia inmutable del veredicto", () => {
    runAll(({ detector }) => {
      const before = detector.getVerdict();
      const v = detector.getVerdict();
      expect(Object.keys(v)).toEqual(["state", "score", "confidence", "doubt", "reasons"]);
      expect(v).toEqual(before);
      v.reasons.push("mutado");
      v.state = "ai";
      expect(detector.getVerdict()).toEqual(before);
      expect(detector.getVerdict().reasons).not.toContain("mutado");
    }, "bot");
  });
});

describe("L181 · onVerdict(callback)", () => {
  it("aviso solo al cambiar de estado, con copia y unsubscribe", () => {
    let count = 0;
    let off: () => void = () => {};
    const s = runSession(
      "bot",
      {},
      {
        onVerdict: () => {
          count += 1;
        },
      },
    );
    try {
      off = s.detector.onVerdict(() => {
        count += 100;
      });
      s.detector.evaluate(); // mismo estado: no dispara
      expect(count).toBeGreaterThan(0);
      const before = count;
      off();
      off();
      s.detector.evaluate();
      expect(count).toBe(before);
    } finally {
      s.finish();
    }
  });
});

describe("L182 · onChange()", () => {
  it("solo humano ↔ IA, nunca measuring", () => {
    const s = runSession("bot", {}, { onThreshold: 0.5 });
    try {
      expect(s.changes.length).toBeGreaterThan(0);
      for (const c of s.changes) expect(["human", "ai"]).toContain(c);
      expect(s.changes).not.toContain("measuring" as never);
    } finally {
      s.finish();
    }
  });
});

describe("L183 · onThreshold(valor, callback)", () => {
  it("dispara en ambos sentidos y con null↔número en una sesión real", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 6000 } });
    d.attachTo(target);
    d.start();
    d.configure({ emaAlpha: 1 });
    const seen: Array<number | null> = [];
    d.onThreshold(0.45, (score) => seen.push(score));
    const human = humanBrowsing();
    emit(target, clock, human);
    d.evaluate();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toBeNull();
    expect(seen[0] as number).toBeLessThan(0.45);
    botTakeover(target, clock, (human[human.length - 1][1].timeStamp as number) + 100);
    d.evaluate();
    expect(seen.some((v) => v !== null && v > 0.45)).toBe(true);
    clock.value = 200000;
    d.evaluate();
    expect(seen[seen.length - 1]).toBeNull();
    d.stop();
  });
});

describe("L184 · getReasons() localizadas", () => {
  it("las 12 locales producen razones traducidas y copias desacopladas", () => {
    const spanish = ((): string[] => {
      const s = runSession("bot", { locale: "es" });
      try {
        return s.detector.getReasons();
      } finally {
        s.finish();
      }
    })();
    expect(spanish.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const s = runSession("bot", { locale });
      try {
        const reasons = s.detector.getReasons();
        expect(reasons).toEqual(translateReasons(spanish, locale));
        if (locale !== "es") expect(reasons).not.toEqual(spanish);
        reasons.push("mutado");
        expect(s.detector.getReasons()).not.toContain("mutado");
      } finally {
        s.finish();
      }
    }
  });

  it("un cambio de locale con configure() se refleja de inmediato en getReasons()", () => {
    const s = runSession("bot", { locale: "en" });
    try {
      const english = s.detector.getReasons();
      s.detector.configure({ locale: "es" });
      expect(s.detector.getLocale()).toBe("es");
      const expected = translateReasons(
        english.map((reason) => {
          // Recuperar la forma canónica española desde la clave inversa.
          const keys = Object.keys(esDictionary as Record<string, string>);
          for (const key of keys) {
            if (t(key as never, "en") === reason)
              return (esDictionary as Record<string, string>)[key];
          }
          return reason;
        }),
        "es",
      );
      expect(s.detector.getReasons()).toEqual(expected);
    } finally {
      s.finish();
    }
  });
});

// Diccionario español leído del módulo i18n (solo para la prueba de cambio de locale).
import { es as esDictionary } from "../../src/i18n/dictionaries";

describe("L185 · getScoreBreakdown()", () => {
  it("expone señales, pesos, EMA, handover, accesibilidad y evidencia aditiva", () => {
    runAll(({ detector }) => {
      const b = detector.getScoreBreakdown();
      for (const key of [
        "scores",
        "weights",
        "effectiveWeights",
        "thresholds",
        "combination",
        "ema",
        "handover",
        "handoverCount",
        "accessibility",
        "reasons",
        "riskEvidence",
        "notes",
      ]) {
        expect(Object.keys(b)).toContain(key);
      }
      expect(inUnit(b.riskEvidence.overall)).toBe(true);
      expect(Array.isArray(b.notes)).toBe(true);
    }, "bot");
  });
});

describe("L186 · reset()", () => {
  it("vuelve a cero sin dejar de escuchar", () => {
    const s = runSession("bot");
    try {
      expect(s.detector.getStats().sampleCount).toBeGreaterThan(0);
      s.detector.reset();
      expect(s.detector.getStats().sampleCount).toBe(0);
      expect(s.detector.getVerdict()).toEqual({
        state: "measuring",
        score: null,
        confidence: 0,
        doubt: 1,
        reasons: [],
      });
      expect(s.target.listenerCount("pointermove")).toBe(1);
    } finally {
      s.finish();
    }
  });
});

describe("L187 · configure(opciones)", () => {
  it("fusiona cambios válidos y fusiona sin compartir referencias", () => {
    const d = new IsThatAnAI();
    const weights = { mouse: 0.9, click: 0.05, scroll: 0.05, keyboard: 0.1 };
    d.configure({ signalWeights: weights, sensitivity: "estricto" });
    weights.mouse = 0; // mutar el llamador no afecta
    expect(d.getConfig().signalWeights.mouse).toBe(0.9);
    expect(d.getConfig().thresholds).toEqual(SENSITIVITY_PRESETS.estricto.thresholds);
  });
});

describe("L188 · attachTo(elemento)", () => {
  it("vigila solo ese target y reinicia al cambiar", () => {
    const clock: Clock = { value: 0 };
    const a = new FakeTarget();
    const b = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(a);
    d.start();
    emit(a, clock, naiveBot().slice(0, 30));
    expect(d.getStats().sampleCount).toBe(30);
    d.attachTo(b);
    expect(d.getStats().sampleCount).toBe(0);
    emit(b, clock, naiveBot().slice(30, 40));
    expect(d.getStats().sampleCount).toBeGreaterThan(0);
    expect(a.listenerCount("pointermove")).toBe(0);
    expect(() => d.attachTo({} as EventTarget)).toThrow(TypeError);
    d.stop();
  });
});

describe("L189 · modo global (toda la página)", () => {
  it("installGlobal expone un detector en window y captura en window", () => {
    const dom = fakeDom();
    try {
      const d = installGlobal("miDetector");
      expect((dom.win as unknown as Record<string, unknown>).miDetector).toBe(d);
      expect(DEFAULT_GLOBAL_NAME).toBe("isThatAnAI");
      const clock: Clock = { value: 0 };
      d.attachTo(dom.win);
      d.start();
      emit(dom.win, clock, naiveBot().slice(0, 30));
      d.evaluate();
      expect(d.getVerdict().score).not.toBeNull();
      d.stop();
    } finally {
      dom.restore();
    }
  });
});

describe("L190 · enableSignals()/disableSignals()", () => {
  it("desactivar una señal la saca de la combinación y del breakdown", () => {
    const s = runSession(
      "bot",
      {},
      {
        configure: (d) => d.disableSignals(["click"]),
      },
    );
    try {
      expect(s.detector.getEnabledSignals()).not.toContain("click");
      expect(s.detector.getSignalScores().click).toBeNull();
      s.detector.enableSignals(["click"]);
      s.detector.evaluate();
      expect(s.detector.getSignalScores().click).not.toBeNull();
    } finally {
      s.finish();
    }
  });
});

describe("L191 · modo debug", () => {
  it("solo registra durante evaluate(), nunca al construir/arrancar", () => {
    const spy = spyOn(console, "debug").mockImplementation(() => {});
    const d = new IsThatAnAI({ debug: true });
    try {
      expect(spy).not.toHaveBeenCalled();
      d.attachTo(new FakeTarget());
      d.start();
      expect(spy).not.toHaveBeenCalled();
      d.evaluate();
      expect(spy).not.toHaveBeenCalled(); // sin muestras también calla salvo evaluate
      d.stop();
      spy.mockClear();
      d.setDebug(false);
      expect(d.isDebug()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("L192 · etiqueta <script> (plug and play)", () => {
  it("la entrada IIFE expone el global y el paquete declara el subpath", () => {
    const entry = readFileSync(new URL("../../src/iife-entry.ts", import.meta.url), "utf8");
    expect(entry).toContain("IsThatAnAI");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./iife"]).toBe("./dist/index.iife.js");
  });
});

describe("L193 · paquete npm", () => {
  it("declara main/types/exports/files y el build genera los artefactos", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.name).toBe("is-that-an-ai");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.files).toContain("dist");
    for (const f of ["index.js", "index.iife.js", "index.d.ts"]) {
      expect(existsSync(new URL(`../../dist/${f}`, import.meta.url))).toBe(true);
    }
  });
});

describe("L194 · envoltorios React/Vue/Svelte", () => {
  it("los tres adaptadores comparten start/stop/instance reales", () => {
    const handles = [
      createReactDetector(),
      createVueDetector(),
      createSvelteDetector(),
      createDetectorHandle(),
    ];
    for (const h of handles) {
      expect(h.instance).toBeInstanceOf(IsThatAnAI);
      const target = new FakeTarget();
      h.instance.attachTo(target);
      h.start();
      expect(target.listenerCount("pointermove")).toBe(1);
      h.stop();
      expect(target.listenerCount("pointermove")).toBe(0);
    }
  });
});

describe("L195 · eventos personalizados del navegador", () => {
  it("despacha CustomEvent('isthatanai') con copia al cambiar de estado", () => {
    const dom = fakeDom();
    const seen: CustomEvent[] = [];
    dom.doc.addEventListener("isthatanai", (e) => seen.push(e as CustomEvent));
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ customEvent: true, now: () => clock.value });
    d.attachTo(target);
    d.start();
    try {
      const events = [...naiveBot(), ...confirmTail("bot", naiveBot())];
      for (let i = 0; i < events.length; i += 10) {
        emit(target, clock, events.slice(i, i + 10));
        d.evaluate();
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].type).toBe("isthatanai");
      expect(Object.keys(seen[0].detail)).toEqual([
        "state",
        "score",
        "confidence",
        "doubt",
        "reasons",
      ]);
      seen[0].detail.reasons.push("mutado");
      expect(d.getVerdict().reasons).not.toContain("mutado");
    } finally {
      d.stop();
      dom.restore();
    }
  });
});

describe("L196 · inicio automático opcional", () => {
  it("sin DOM devuelve null; con DOM arranca y captura", () => {
    const globals = globalThis as unknown as { document?: unknown };
    const prev = globals.document;
    Reflect.deleteProperty(globals, "document");
    expect(autoStart()).toBeNull();
    if (prev === undefined) delete globals.document;
    else globals.document = prev;

    const dom = fakeDom();
    let d: IsThatAnAI | null = null;
    try {
      d = autoStart();
      expect(d).not.toBeNull();
      const clock: Clock = { value: 0 };
      emit(dom.win, clock, naiveBot().slice(0, 30));
      d?.evaluate();
      expect(d?.getVerdict().score).not.toBeNull();
    } finally {
      d?.stop();
      dom.restore();
    }
  });
});

describe("L197 · peso mínimo", () => {
  it("el IIFE minificado se mantiene por debajo del límite declarado", () => {
    const iife = new URL("../../dist/index.iife.js", import.meta.url);
    if (!existsSync(iife)) return;
    const kb = statSync(iife).size / 1024;
    expect(kb).toBeLessThan(250);
    expect(readFileSync(iife, "utf8")).toContain("IsThatAnAI");
  });
});

// ===========================================================================
// PRIVACIDAD Y SEGURIDAD (L199–L208)
// ===========================================================================

describe("L199 · cero envío de datos", () => {
  it("auditoría y escaneo estático: sin fetch/XHR/WebSocket en el alcance", async () => {
    expect(privacyAudit()).toEqual({
      networkCalls: 0,
      persistentStorage: 0,
      cookies: 0,
      keyIdentities: 0,
    });
    const paths = [
      "../../src/core/detector.ts",
      "../../src/scoring/score.ts",
      "../../src/utils/privacy.ts",
      "../../src/utils/privacy-audit.ts",
      "../../src/utils/privacy-shape.ts",
      "../../src/auto-start.ts",
      "../../src/global.ts",
    ];
    const sources = await Promise.all(
      paths.map((p) => Bun.file(new URL(p, import.meta.url)).text()),
    );
    const code = sources
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(/);
  });
});

describe("L200 · nunca guarda qué teclas se presionan", () => {
  it("teclear un párrafo con secretos guarda solo tiempos y categorías", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(target);
    d.start();
    const secret = "CONTRASENA-SECRETA-9f3b";
    const evs: Emission[] = [];
    for (let i = 0; i < 24; i += 1) {
      const base = i * 120;
      evs.push([
        "keydown",
        { code: "KeyA", key: secret[i % secret.length], timeStamp: base, isTrusted: true },
      ]);
      evs.push([
        "keyup",
        { code: "KeyA", key: secret[i % secret.length], timeStamp: base + 60, isTrusted: true },
      ]);
    }
    emit(target, clock, evs);
    d.evaluate();
    const keys = d.getRecentKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(Object.keys(k).sort()).toEqual(["category", "kind", "seq", "t", "trusted"]);
      expect(Number.isFinite(k.category)).toBe(true);
    }
    for (const getter of [
      () => JSON.stringify(keys),
      () => JSON.stringify(d.getVerdict()),
      () => JSON.stringify(d.getStats()),
      () => JSON.stringify(d.getScoreBreakdown()),
      () => JSON.stringify(d.getRecentInputs()),
    ]) {
      expect(getter()).not.toContain("CONTRASENA");
    }
    d.stop();
  });
});

describe("L201 · no guarda texto escrito", () => {
  it("mutaciones de texto con data/clipboardData no dejan rastro", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(target);
    d.start();
    const secret = "TEXTOCONFIGIDENCIAL-xyz";
    const evs: Emission[] = [];
    for (let i = 0; i < 10; i += 1) {
      evs.push([
        "beforeinput",
        {
          inputType: "insertText",
          data: secret,
          clipboardData: { getData: () => secret },
          timeStamp: i * 100,
          isTrusted: true,
        },
      ]);
    }
    emit(target, clock, evs);
    d.evaluate();
    expect(JSON.stringify(d.getRecentInputs())).not.toContain("CONFIDENCIAL");
    expect(JSON.stringify(d.getVerdict())).not.toContain("CONFIDENCIAL");
    d.stop();
  });
});

describe("L202 · ignora campos de contraseña", () => {
  it("ni siquiera mide tiempos en un input[type=password]", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(target);
    d.start();
    const pwd = {
      tagName: "INPUT",
      type: "password",
      get value(): string {
        throw new Error("valor leído");
      },
    };
    expect(() => {
      emit(target, clock, [
        ["keydown", { code: "KeyA", key: "a", timeStamp: 10, isTrusted: true, target: pwd }],
        ["keyup", { code: "KeyA", timeStamp: 60, isTrusted: true, target: pwd }],
        [
          "beforeinput",
          { inputType: "insertText", data: "x", timeStamp: 70, isTrusted: true, target: pwd },
        ],
      ]);
    }).not.toThrow();
    expect(d.getRecentKeys()).toEqual([]);
    expect(d.getRecentInputs()).toEqual([]);
    d.stop();
  });
});

describe("L203 · datos en memoria (sin almacenamiento)", () => {
  it("reset/stop descartan todo y el código no toca storage", async () => {
    const paths = [
      "../../src/core/detector.ts",
      "../../src/scoring/score.ts",
      "../../src/utils/privacy-shape.ts",
    ];
    const sources = await Promise.all(
      paths.map((p) => Bun.file(new URL(p, import.meta.url)).text()),
    );
    const code = sources
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const s = runSession("bot");
    try {
      s.detector.reset();
      expect(s.detector.getStats().sampleCount).toBe(0);
      s.detector.stop();
      expect(s.detector.getStats().sampleCount).toBe(0);
    } finally {
      s.finish();
    }
  });
});

describe("L204 · sin cookies, rastreo ni huella digital", () => {
  it("privacyAudit y el código fuente confirman ausencia por construcción", () => {
    expect(privacyAudit().cookies).toBe(0);
    expect(PRIVACY_NOTICE).not.toMatch(/https?:\/\//);
    expect(PRIVACY_NOTICE.length).toBeGreaterThan(50);
  });
});

describe("L205 · modo solo agregados", () => {
  it("getStats() publica conteos pero nunca marcas crudas", () => {
    const s = runSession("bot", { aggregatesOnly: true, mouse: { maxAgeMs: 1e6 } });
    try {
      expect(s.detector.getPrivacyMode()).toBe("aggregates");
      const stats = s.detector.getStats();
      const json = JSON.stringify(stats);
      expect(json).not.toContain("lastEventAt");
      expect(json).not.toContain("timestamp");
      expect(Object.values(stats).every((v) => typeof v === "number" && Number.isFinite(v))).toBe(
        true,
      );
      expect(
        (s.detector.getScoreBreakdown() as unknown as Record<string, unknown>).privacyMode,
      ).toBe("aggregates");
    } finally {
      s.finish();
    }
  });
});

describe("L206 · redondeo de datos", () => {
  it("roundTiming elimina precisión y el modo agregados redondea señales", () => {
    expect(roundTiming(123)).toBe(100);
    expect(roundTiming(126)).toBe(150);
    expect(roundTiming(Number.NaN)).toBe(0);
    const s = runSession("bot", { aggregatesOnly: true, mouse: { maxAgeMs: 1e6 } });
    try {
      const value = s.detector.getSignalScores().mouse as number;
      expect(Math.abs(value * 20 - Math.round(value * 20))).toBeLessThan(1e-9);
    } finally {
      s.finish();
    }
  });
});

describe("L207 · respeta No rastrear", () => {
  it("navigator.doNotTrack activa el modo agregados en start()", () => {
    const globals = globalThis as unknown as { navigator?: unknown };
    const prev = globals.navigator;
    Object.defineProperty(globals, "navigator", {
      value: { doNotTrack: "1" },
      configurable: true,
      writable: true,
    });
    try {
      const dom = fakeDom();
      const d = new IsThatAnAI({ now: () => 0 });
      try {
        expect(d.getPrivacyMode()).toBe("full");
        d.attachTo(new FakeTarget());
        d.start();
        expect(d.getPrivacyMode()).toBe("aggregates");
      } finally {
        d.stop();
        dom.restore();
      }
    } finally {
      if (prev === undefined) Reflect.deleteProperty(globals, "navigator");
      else globals.navigator = prev;
    }
  });
});

describe("L208 · aviso de transparencia", () => {
  it("PRIVACY_NOTICE es verificable y dice la verdad", () => {
    expect(PRIVACY_NOTICE).toContain("no envía datos");
    expect(PRIVACY_NOTICE).toContain("no usa cookies");
    expect(PRIVACY_NOTICE).toContain("nunca guarda qué teclas");
    expect(t("privacy.notice", "es")).toBe(PRIVACY_NOTICE);
  });
});

// ===========================================================================
// L219/L220 · GRABACIÓN / EXPORTACIÓN Y RECALIBRACIÓN (lado librería)
// ===========================================================================

describe("L219/L220 · forma de exportación de la sesión grabada", () => {
  it("los getters producen un CalibrationSession exportable con muestras reales", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 1e6 } });
    d.attachTo(target);
    d.start();
    const evs: Emission[] = [];
    for (let i = 0; i < 20; i += 1) {
      const base = i * 180;
      evs.push(["keydown", { code: "KeyA", timeStamp: base, isTrusted: true }]);
      evs.push(["keyup", { code: "KeyA", timeStamp: base + 90, isTrusted: true }]);
      evs.push([
        "pointermove",
        {
          clientX: i * 2,
          clientY: i * 3,
          timeStamp: base + 30,
          pointerType: "mouse",
          isTrusted: true,
        },
      ]);
    }
    emit(target, clock, evs);
    d.evaluate();
    const session: CalibrationSession = {
      keys: d.getRecentKeys(),
      inputs: d.getRecentInputs(),
      points: d.getRecentPoints(),
      clicks: d.getRecentClicks(),
      scrolls: d.getRecentScrolls(),
    };
    expect(session.keys?.length).toBe(40);
    expect(session.points?.length).toBe(20);
    expect(() => calibrationFromSession(session)).not.toThrow();
    expect(calibrationFromSession(session).applied).toBe(true);
    d.stop();
  });
});

describe("L219/L220 · recalibración desde la sesión grabada", () => {
  it("aplica la calibración en memoria SIN alterar el veredicto ni filtrar secretos", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value, mouse: { maxAgeMs: 1e6 } });
    d.attachTo(target);
    d.start();
    const evs: Emission[] = [];
    for (let i = 0; i < 20; i += 1) {
      const base = i * 180;
      evs.push(["keydown", { code: "KeyA", timeStamp: base, isTrusted: true }]);
      evs.push(["keyup", { code: "KeyA", timeStamp: base + 90, isTrusted: true }]);
    }
    emit(target, clock, evs);
    d.evaluate();
    const before = d.getVerdict();
    const session = {
      keys: d.getRecentKeys(),
      inputs: d.getRecentInputs(),
      points: d.getRecentPoints(),
      clicks: d.getRecentClicks(),
      scrolls: d.getRecentScrolls(),
      verdict: "human",
      bypass: true,
      adjustments: { pauseMs: 999, rhythmTolerance: 999 },
    };
    const res = d.recalibrateFromSession(session);
    expect(res.applied).toBe(true);
    expect(Object.keys(res).sort()).toEqual(["adjustments", "applied", "reasons", "samples"]);
    for (const value of Object.values(res.adjustments)) expect(value).toBeLessThanOrEqual(1.2);
    expect(JSON.stringify(res)).not.toContain("human");
    expect(d.getVerdict()).toEqual(before);
    d.resetCalibration();
    expect(d.getCalibration()).toBeNull();
    d.stop();
  });
});

// ===========================================================================
// CASOS HOSTILES Y FAIL-CLOSED
// ===========================================================================

describe("Config hostil · prototype pollution y getters que lanzan", () => {
  it("objetos envenenados no alteran la configuración ni lanzan", () => {
    const poison = Object.create({
      thresholds: { humanMax: 0.99, aiMin: 0.01 },
      signalWeights: { mouse: 1, click: 1, scroll: 1, keyboard: 1 },
      emaAlpha: 1,
      locale: "es",
    });
    const d = new IsThatAnAI(poison as DetectorOptions);
    expect(() => d.configure(poison)).not.toThrow();
    const cfg = d.getConfig();
    expect(cfg.thresholds).toEqual({ humanMax: HUMAN_MAX, aiMin: AI_MIN });
    expect(cfg.signalWeights.mouse).toBe(0.6);
    expect(cfg.emaAlpha).toBe(EMA_ALPHA);
    expect(d.getLocale()).toBe("en");

    const throwing = new Proxy(
      {},
      {
        get(): unknown {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor(): undefined {
          return undefined;
        },
      },
    );
    expect(() => d.configure(throwing as never)).not.toThrow();
    expect(d.getConfig()).toEqual(cfg);
  });
});

describe("Callbacks hostiles · throw y re-entrada desde onVerdict", () => {
  it("un callback que lanza o llama a reset() no rompe la máquina de estados", () => {
    const clock: Clock = { value: 0 };
    const target = new FakeTarget();
    const d = new IsThatAnAI({ now: () => clock.value });
    d.attachTo(target);
    d.start();
    let reached = false;
    d.onVerdict(() => {
      throw new Error("callback roto");
    });
    d.onVerdict((v) => {
      if (v.state === "ai") {
        reached = true;
        d.reset(); // re-entrada
      }
    });
    try {
      const events = [...naiveBot(), ...confirmTail("bot", naiveBot())];
      for (let i = 0; i < events.length; i += 10) {
        expect(() => {
          emit(target, clock, events.slice(i, i + 10));
          d.evaluate();
        }).not.toThrow();
      }
      expect(reached).toBe(true);
      expect(d.getVerdict().state).toBe("measuring");
    } finally {
      d.stop();
    }
  });
});

describe("SSR · importar la librería sin DOM", () => {
  it("el constructor y el import no tocan window/document/navigator", () => {
    const entry = new URL("../../src/core/detector.ts", import.meta.url).href;
    const code = [
      'Object.defineProperty(globalThis, "navigator", { value: { language: "es-ES" }, configurable: true });',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      'const d = new IsThatAnAI({ locale: "auto" });',
      'if (d.getLocale() !== "en") throw new Error("constructor tocó navigator");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      "d.start();",
      'if (d.getLocale() !== "en") throw new Error("start sin navigator no cae a en");',
      "d.stop();",
      "console.log('ssr-ok');",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) console.error(new TextDecoder().decode(result.stderr));
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("ssr-ok");
  });
});

describe("Fail-closed · integridad manipulada", () => {
  it("verifyIntegrity roto fuerza measuring, score null y razón localizada", () => {
    const globals = globalThis as unknown as { Date?: unknown };
    const prev = globals.Date;
    globals.Date = undefined;
    try {
      const clock: Clock = { value: 0 };
      const target = new FakeTarget();
      const d = new IsThatAnAI({ now: () => clock.value });
      d.attachTo(target);
      d.start();
      emit(target, clock, naiveBot());
      d.evaluate();
      expect(d.getIntegrity().ok).toBe(false);
      expect(d.getVerdict().state).toBe("measuring");
      expect(d.getVerdict().score).toBeNull();
      expect(d.getVerdict().reasons).toContain("Integrity verified: tampering detected");
      expect(d.getScoreBreakdown().notes).toContain(
        "Integridad verificada: manipulación detectada",
      );
      d.stop();
    } finally {
      globals.Date = prev;
    }
  });
});
