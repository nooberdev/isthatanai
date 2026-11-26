// Tests deterministas para los ítems "parciales" del checklist:
// scoring (pesos, combinación, handover, accesibilidad, umbrales) y API
// (onChange, getReasons, getScoreBreakdown, reset, configure, attachTo).
// Ningún test depende de reloj de pared ni de un DOM real.

import { describe, expect, it } from "bun:test";
import { IsThatAnAI } from "../src/index";
import {
  ACCESSIBILITY_SCORE_FACTOR,
  AI_CONFIRM_MS,
  AI_MIN,
  doubtFor,
  EMA_ALPHA,
  HUMAN_CONFIRM_MS,
  HUMAN_MAX,
  SCORED_SIGNALS,
  ScoreComputer,
  SIGNAL_DIFFICULTY,
  SIGNAL_WEIGHTS,
} from "../src/scoring/score";
import type { ClickSample, DetectorConfig, PointerSample, ScoreBreakdown } from "../src/types";

const MEASURING = { state: "measuring", score: null, confidence: 0, doubt: 1, reasons: [] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function event(type: string, props: Record<string, unknown>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(result, key, { value, configurable: true });
  }
  return result;
}

function move(x: number, t: number, pointerType = "mouse"): Event {
  return event("pointermove", {
    clientX: x,
    clientY: x * 2,
    timeStamp: t,
    pointerType,
    isTrusted: true,
  });
}

function key(type: "keydown" | "keyup", code: string, t: number): Event {
  return event(type, { code, key: code, timeStamp: t, isTrusted: true });
}

function dispatchAll(target: EventTarget, events: Event[]): void {
  for (const e of events) target.dispatchEvent(e);
}

/** DOM falso; el reloj inyectado sigue el timeStamp del último evento. */
function fakeDom(): {
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  clock: () => number;
  restore: () => void;
} {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  let t = 0;
  const wrap = (target: EventTarget): void => {
    const original = target.dispatchEvent.bind(target);
    target.dispatchEvent = ((e: Event) => {
      if (Number.isFinite(e.timeStamp)) t = e.timeStamp;
      return original(e);
    }) as typeof target.dispatchEvent;
  };
  wrap(windowTarget);
  wrap(documentTarget);
  globals.window = windowTarget;
  globals.document = documentTarget;
  return {
    windowTarget,
    documentTarget,
    clock: () => t,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    },
  };
}

/** Evalúa cada `every` eventos para respetar la confirmación por tiempo. */
function runConfirmed(detector: IsThatAnAI, target: EventTarget, events: Event[], every = 5): void {
  for (let i = 0; i < events.length; i += 1) {
    target.dispatchEvent(events[i]);
    if ((i + 1) % every === 0 || i === events.length - 1) detector.evaluate();
  }
}

function humanSequence(count: number, t0 = 0): Event[] {
  const out: Event[] = [];
  let x = 0.5;
  let y = 0;
  for (let i = 0; i < count; i += 1) {
    const dt = 35 + ((i * 29) % 65);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    const dy = ((i * 5) % 7) - 3 + 0.2;
    if (i % 5 === 2) x -= dx * 0.8;
    else x += dx;
    y += dy;
    out.push(
      event("pointermove", {
        clientX: x,
        clientY: y,
        timeStamp: t0 + i * dt,
        pointerType: "mouse",
        isTrusted: true,
      }),
    );
  }
  return out;
}

function teleportSequence(count: number, t0: number, dt = 60): Event[] {
  return Array.from({ length: count }, (_, i) =>
    move(10 * i + (i % 8 === 0 ? 300 : 0), t0 + i * dt),
  );
}

function arrowBot(count: number, t0 = 0): Event[] {
  const out: Event[] = [];
  let t = t0;
  for (let i = 0; i < count; i += 1) {
    const code = i % 2 === 0 ? "ArrowRight" : "ArrowDown";
    out.push(key("keydown", code, t));
    out.push(key("keyup", code, t + 45));
    t += 60;
  }
  return out;
}

function straightSamples(n: number): PointerSample[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    x: i * 10,
    y: 0,
    t: i * 60,
    kind: 0 as const,
    pointerType: 0 as const,
    trusted: 1 as const,
  }));
}

function botClickSamples(count: number): ClickSample[] {
  const out: ClickSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i * 100;
    out.push({ seq: out.length + 1, x: 500.5, y: 300.25, t, kind: 0, button: 0, trusted: 1 });
    out.push({
      seq: out.length + 1,
      x: 500.5,
      y: 300.25,
      t: t + 60,
      kind: 1,
      button: 0,
      trusted: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// L163 · Pesos configurables
// ---------------------------------------------------------------------------

describe("L163: pesos configurables por señal", () => {
  it("los defaults coinciden con SIGNAL_WEIGHTS y un override parcial hace merge", () => {
    const computer = new ScoreComputer();
    expect(computer.getConfig().signalWeights).toEqual({ ...SIGNAL_WEIGHTS });

    computer.configure({ signalWeights: { mouse: 0.9 } });
    expect(computer.getConfig().signalWeights).toEqual({
      mouse: 0.9,
      click: SIGNAL_WEIGHTS.click,
      scroll: SIGNAL_WEIGHTS.scroll,
      keyboard: SIGNAL_WEIGHTS.keyboard,
    });
    expect(SCORED_SIGNALS).toEqual(["mouse", "click", "scroll", "keyboard"]);
  });

  it("cambiar el peso de una señal cambia la combinación", () => {
    const samples = straightSamples(30);
    const clicks = botClickSamples(10);
    const windowMs = 30 * 60;

    const base = new ScoreComputer().evaluate(samples, windowMs, clicks).score as number;
    const shifted = new ScoreComputer();
    shifted.configure({ signalWeights: { mouse: 0.1, click: 0.8 } });
    const alt = shifted.evaluate(samples, windowMs, clicks).score as number;

    // El mouse (score moderado) pierde peso frente a los clics bot (score alto).
    expect(alt).toBeGreaterThan(base);
    expect(shifted.getConfig().signalWeights.mouse).toBe(0.1);
    expect(shifted.getConfig().signalWeights.click).toBe(0.8);
  });

  it("valores no finitos no sustituyen al peso previo", () => {
    const computer = new ScoreComputer();
    computer.configure({ signalWeights: { mouse: Number.NaN } });
    expect(computer.getConfig().signalWeights.mouse).toBe(SIGNAL_WEIGHTS.mouse);
  });
});

// ---------------------------------------------------------------------------
// L164 · Combinación inteligente
// ---------------------------------------------------------------------------

describe("L164: combinación que favorece señales difíciles de falsificar", () => {
  it("modo adaptive pondera mouse/teclado por encima de click/scroll", () => {
    const computer = new ScoreComputer();
    computer.configure({
      signalWeights: { mouse: 0.5, click: 0.5, scroll: 0.5, keyboard: 0.5 },
      combination: "adaptive",
    });
    const effective = computer.getEffectiveWeights();
    expect(effective.mouse).toBeCloseTo(0.5 * SIGNAL_DIFFICULTY.mouse, 6);
    expect(effective.keyboard).toBeCloseTo(0.5 * SIGNAL_DIFFICULTY.keyboard, 6);
    expect(effective.click).toBeCloseTo(0.5 * SIGNAL_DIFFICULTY.click, 6);
    expect(effective.scroll).toBeCloseTo(0.5 * SIGNAL_DIFFICULTY.scroll, 6);
    expect(effective.mouse).toBeGreaterThan(effective.click);
    expect(effective.keyboard).toBeGreaterThan(effective.scroll);
  });

  it("adaptive acerca el score a la señal difícil cuando las pesan igual", () => {
    const samples = straightSamples(30);
    const clicks = botClickSamples(10);
    const windowMs = 30 * 60;
    const weights = { mouse: 0.5, click: 0.5, scroll: 0.5, keyboard: 0.5 };

    const weighted = new ScoreComputer();
    weighted.configure({ signalWeights: weights, combination: "weighted" });
    const adaptive = new ScoreComputer();
    adaptive.configure({ signalWeights: weights, combination: "adaptive" });

    const base = weighted.evaluate(samples, windowMs, clicks).score as number;
    const smart = adaptive.evaluate(samples, windowMs, clicks).score as number;
    expect(smart).toBeLessThan(base);
  });

  it("el modo weighted mantiene los pesos documentados sin multiplicadores", () => {
    const computer = new ScoreComputer();
    computer.configure({ combination: "weighted" });
    expect(computer.getEffectiveWeights()).toEqual({ ...SIGNAL_WEIGHTS });
  });
});

// ---------------------------------------------------------------------------
// L170 · Cambio de controlador
// ---------------------------------------------------------------------------

describe("L170: detección de cambio de controlador", () => {
  it("detecta humano -> IA y luego IA -> humano sin tocar el veredicto", () => {
    const { windowTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: clock });
      const emitted: string[] = [];
      detector.onVerdict((v) => emitted.push(v.state));
      detector.start();

      // Fase 1: humano convincente.
      runConfirmed(detector, windowTarget, humanSequence(30, 0), 5);
      expect(detector.getVerdict().state).toBe("human");
      expect(detector.getScoreBreakdown().handover).toBeNull();

      // Fase 2: mismo detector, control lo toma un bot (saltos imposibles).
      runConfirmed(detector, windowTarget, teleportSequence(60, 30000, 60), 10);
      detector.evaluate();
      const first = detector.getScoreBreakdown() as ScoreBreakdown;
      expect(detector.getVerdict().state).toBe("ai");
      expect(first.handover).not.toBeNull();
      expect(first.handover?.from).toBe("human");
      expect(first.handover?.to).toBe("ai");
      expect(first.handover?.score).toBeGreaterThanOrEqual(AI_MIN);
      expect(first.handoverCount).toBe(1);
      expect(first.reasons.some((r) => r.includes("Cambio de controlador"))).toBe(true);

      // Fase 3: el bot devuelve el control a un humano.
      runConfirmed(detector, windowTarget, humanSequence(60, 60000), 10);
      detector.evaluate();
      const second = detector.getScoreBreakdown();
      expect(detector.getVerdict().state).toBe("human");
      expect(second.handover?.from).toBe("ai");
      expect(second.handover?.to).toBe("human");
      expect(second.handoverCount).toBe(2);
      // Al expirar las muestras de IA hay un hueco legítimo de evidencia:
      // `measuring` se emite por onVerdict, pero onChange nunca lo ve.
      expect(emitted).toEqual(["human", "ai", "measuring", "human"]);

      detector.stop();
    } finally {
      restore();
    }
  });

  it("reset y stop borran el historial de handover", () => {
    const { windowTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: clock });
      detector.start();
      runConfirmed(detector, windowTarget, humanSequence(30, 0), 5);
      runConfirmed(detector, windowTarget, teleportSequence(40, 30000, 60), 10);
      expect(detector.getScoreBreakdown().handoverCount).toBe(1);

      detector.reset();
      expect(detector.getScoreBreakdown().handover).toBeNull();
      expect(detector.getScoreBreakdown().handoverCount).toBe(0);
      detector.stop();
      expect(detector.getScoreBreakdown().handover).toBeNull();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// L171 · Protección por accesibilidad
// ---------------------------------------------------------------------------

describe("L171: protección por accesibilidad reutilizando el perfil", () => {
  it("perfil tv: atenúa el score con evidencia existente", () => {
    const { documentTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ device: "tv", now: clock });
      detector.start();
      runConfirmed(detector, documentTarget, arrowBot(40, 0), 5);
      detector.evaluate();
      const before = detector.getVerdict().score as number;
      expect(before).toBeGreaterThan(AI_MIN);
      expect(detector.getScoreBreakdown().accessibility.applied).toBe(false);

      detector.configure({ accessibilityProtection: true });
      runConfirmed(detector, documentTarget, arrowBot(12, 4000), 5);
      detector.evaluate();
      const after = detector.getVerdict().score as number;
      expect(after).toBeLessThan(before);
      expect(after).toBeCloseTo(
        (detector.getScoreBreakdown().ema.current as number) * ACCESSIBILITY_SCORE_FACTOR,
        6,
      );
      expect(detector.getScoreBreakdown().accessibility).toEqual({
        enabled: true,
        device: "tv",
        applied: true,
      });
      detector.stop();
    } finally {
      restore();
    }
  });

  it("perfil touch inferido: también atenúa", () => {
    const { windowTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: clock });
      detector.configure({ accessibilityProtection: true });
      detector.start();
      const events = straightSamples(30).map((s) => move(s.x, s.t, "touch"));
      runConfirmed(detector, windowTarget, events, 5);
      detector.evaluate();

      expect(detector.getDeviceProfile()).toBe("touch");
      expect(detector.getScoreBreakdown().accessibility.device).toBe("touch");
      expect(detector.getScoreBreakdown().accessibility.applied).toBe(true);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("sin evidencia NUNCA convierte measuring en humano", () => {
    const { documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ device: "tv", now: () => 0 });
      detector.configure({ accessibilityProtection: true });
      detector.start();
      // 6 pulsaciones: por debajo del mínimo de evidencia de teclado.
      dispatchAll(documentTarget, arrowBot(6, 0));
      detector.evaluate();

      expect(detector.getVerdict()).toEqual(MEASURING);
      expect(detector.getSignalScores().keyboard).toBeNull();
      expect(detector.getScoreBreakdown().accessibility.applied).toBe(false);
      detector.stop();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// L175 · Umbrales configurables
// ---------------------------------------------------------------------------

describe("L175: umbrales configurables por web", () => {
  it("configure cambia la banda de decisión sin alterar el scoring", () => {
    function stateWith(config?: DetectorConfig): string {
      const { windowTarget, restore } = fakeDom();
      try {
        const detector = new IsThatAnAI({ now: () => 0 });
        if (config) detector.configure(config);
        detector.start();
        runConfirmed(detector, windowTarget, teleportSequence(40, 0, 60), 5);
        detector.evaluate();
        return detector.getVerdict().state;
      } finally {
        restore();
      }
    }

    expect(stateWith()).toBe("ai");
    expect(stateWith({ thresholds: { aiMin: 0.99 } })).not.toBe("ai");
    expect(stateWith({ thresholds: { aiMin: 0.99 } })).toBe("human");
  });

  it("doubtFor acepta bandas configuradas y mantiene los defaults", () => {
    expect(doubtFor("human", 0.32)).toBeCloseTo((0.32 - 0.15) / (AI_MIN - 0.15), 6);
    expect(doubtFor("ai", 0.6, { humanMax: 0.2, aiMin: 0.5 })).toBeCloseTo(
      (0.85 - 0.6) / (0.85 - 0.5),
      6,
    );
    expect(doubtFor("ai", 0.5, { humanMax: 0.2, aiMin: 0.5 })).toBe(1);
  });

  it("configure fusiona todo con los defaults y sin argumentos no cambia nada", () => {
    const detector = new IsThatAnAI();
    expect(detector.getConfig()).toEqual({
      thresholds: { humanMax: HUMAN_MAX, aiMin: AI_MIN },
      signalWeights: { ...SIGNAL_WEIGHTS },
      device: "auto",
      combination: "weighted",
      accessibilityProtection: false,
      confirmMs: { human: HUMAN_CONFIRM_MS, ai: AI_CONFIRM_MS },
      emaAlpha: EMA_ALPHA,
    });

    detector.configure({
      thresholds: { aiMin: 0.4 },
      signalWeights: { mouse: 0.7 },
      device: "tv",
      combination: "adaptive",
      accessibilityProtection: true,
      confirmMs: { ai: 100 },
      emaAlpha: 0.5,
    });
    const merged = detector.getConfig();
    expect(merged).toEqual({
      thresholds: { humanMax: HUMAN_MAX, aiMin: 0.4 },
      signalWeights: { ...SIGNAL_WEIGHTS, mouse: 0.7 },
      device: "tv",
      combination: "adaptive",
      accessibilityProtection: true,
      confirmMs: { human: HUMAN_CONFIRM_MS, ai: 100 },
      emaAlpha: 0.5,
    });
    expect(detector.getDeviceProfile()).toBe("tv");

    detector.configure();
    expect(detector.getConfig()).toEqual(merged);
  });
});

// ---------------------------------------------------------------------------
// L182 · onChange
// ---------------------------------------------------------------------------

describe("L182: onChange solo humano ↔ IA", () => {
  it("emite en cada cambio confirmado, una sola vez por flip, y respeta unsubscribe", () => {
    const { windowTarget, restore } = fakeDom();
    try {
      const changes: string[] = [];
      const detector = new IsThatAnAI({ now: () => 0 });
      const unsubscribe = detector.onChange((state) => changes.push(state));
      expect(typeof unsubscribe).toBe("function");

      detector.start();
      detector.evaluate(); // sin muestras: permanece en measuring
      detector.stop();
      expect(changes).toEqual([]);

      // Fase humana.
      detector.start();
      runConfirmed(detector, windowTarget, humanSequence(30, 0), 5);
      detector.evaluate();
      detector.evaluate();
      expect(changes).toEqual(["human"]);

      // Fase IA (nueva sesión: stop/start limpia buffers e histeresis).
      detector.stop();
      detector.start();
      runConfirmed(detector, windowTarget, teleportSequence(30, 0, 60), 5);
      detector.evaluate();
      expect(changes).toEqual(["human", "ai"]);

      // Volver a humano emite otra vez; measuring no emite nada.
      detector.stop();
      expect(changes).toEqual(["human", "ai"]);
      detector.start();
      runConfirmed(detector, windowTarget, humanSequence(30, 0), 5);
      expect(changes).toEqual(["human", "ai", "human"]);

      unsubscribe();
      detector.stop();
      detector.start();
      runConfirmed(detector, windowTarget, teleportSequence(30, 0, 60), 5);
      expect(changes).toEqual(["human", "ai", "human"]);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("los callbacks de onChange son independientes de onVerdict", () => {
    const { windowTarget, restore } = fakeDom();
    try {
      const changes: string[] = [];
      const verdicts: string[] = [];
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.onChange((s) => changes.push(s));
      detector.onVerdict((v) => verdicts.push(v.state));
      detector.start();
      runConfirmed(detector, windowTarget, humanSequence(30, 0), 5);
      expect(changes).toEqual(["human"]);
      expect(verdicts).toEqual(["human"]);
      detector.stop();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// L184 · getReasons
// ---------------------------------------------------------------------------

describe("L184: getReasons", () => {
  it("devuelve una copia de las razones actuales", () => {
    const { windowTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      expect(detector.getReasons()).toEqual([]);
      detector.start();
      runConfirmed(detector, windowTarget, teleportSequence(30, 0, 60), 5);
      detector.evaluate();

      const reasons = detector.getReasons();
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons).toEqual(detector.getVerdict().reasons);
      reasons.push("manipulada");
      expect(detector.getReasons()).not.toContain("manipulada");
      detector.stop();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// L185 · getScoreBreakdown
// ---------------------------------------------------------------------------

describe("L185: getScoreBreakdown", () => {
  it("expone señales, pesos, umbrales y EMA sin tocar las formas fijadas", () => {
    const { windowTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      const empty = detector.getScoreBreakdown();
      expect(empty.scores).toEqual({ mouse: null, click: null, scroll: null });
      expect(Object.keys(empty.scores)).toEqual(["mouse", "click", "scroll"]);
      expect(empty.scores.keyboard).toBeNull();
      expect(empty.weights).toEqual({ ...SIGNAL_WEIGHTS });
      expect(empty.effectiveWeights).toEqual({ ...SIGNAL_WEIGHTS });
      expect(empty.thresholds).toEqual({ humanMax: HUMAN_MAX, aiMin: AI_MIN });
      expect(empty.combination).toBe("weighted");
      expect(empty.ema).toEqual({ alpha: EMA_ALPHA, previous: null, current: null });
      expect(empty.handover).toBeNull();
      expect(empty.handoverCount).toBe(0);
      expect(empty.accessibility).toEqual({ enabled: false, device: "desktop", applied: false });

      detector.start();
      runConfirmed(detector, windowTarget, teleportSequence(30, 0, 60), 5);
      detector.evaluate();
      const filled = detector.getScoreBreakdown();
      expect(filled.scores.mouse).toBe(detector.getSignalScores().mouse);
      expect(filled.ema.current).toBe(detector.getVerdict().score);
      expect(typeof filled.ema.previous).toBe("number");

      // Formas enumerables de Verdict/SignalScores intactas.
      expect(Object.keys(detector.getVerdict())).toEqual([
        "state",
        "score",
        "confidence",
        "doubt",
        "reasons",
      ]);
      expect(detector.getVerdict()).toEqual({
        state: detector.getVerdict().state,
        score: detector.getVerdict().score,
        confidence: detector.getVerdict().confidence,
        doubt: detector.getVerdict().doubt,
        reasons: detector.getVerdict().reasons,
      });
      detector.stop();
    } finally {
      restore();
    }
  });

  it("el breakdown es una instantánea: mutarlo no altera el detector", () => {
    const detector = new IsThatAnAI();
    const breakdown = detector.getScoreBreakdown();
    breakdown.weights.mouse = 999;
    breakdown.thresholds.aiMin = 999;
    expect(detector.getConfig().signalWeights.mouse).toBe(SIGNAL_WEIGHTS.mouse);
    expect(detector.getConfig().thresholds.aiMin).toBe(AI_MIN);
  });
});

// ---------------------------------------------------------------------------
// L186 · reset
// ---------------------------------------------------------------------------

describe("L186: reset", () => {
  it("limpia EMA, señales, buffers, veredicto e histeresis y sigue escuchando", () => {
    const { windowTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: clock });
      detector.start();
      runConfirmed(detector, windowTarget, teleportSequence(30, 0, 60), 5);
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      expect(detector.getStats().sampleCount).toBeGreaterThan(0);

      detector.reset();
      expect(detector.getVerdict()).toEqual(MEASURING);
      expect(detector.getSignalScores()).toEqual({ mouse: null, click: null, scroll: null });
      expect(detector.getRecentPoints()).toEqual([]);
      expect(detector.getRecentClicks()).toEqual([]);
      expect(detector.getRecentScrolls()).toEqual([]);
      expect(detector.getStats().sampleCount).toBe(0);
      expect(detector.getMouseFeatures()).toBeNull();
      expect(detector.getScoreBreakdown().ema).toEqual({
        alpha: EMA_ALPHA,
        previous: null,
        current: null,
      });

      // No detiene los listeners: una nueva fase vuelve a puntuar.
      runConfirmed(detector, windowTarget, teleportSequence(30, 30000, 60), 5);
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      detector.stop();
      expect(detector.getVerdict()).toEqual(MEASURING);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// L188 · attachTo
// ---------------------------------------------------------------------------

describe("L188: attachTo", () => {
  it("escucha solo el target indicado, no window/document", () => {
    const { windowTarget, documentTarget, restore } = fakeDom();
    const form = new EventTarget();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.attachTo(form);
      detector.start();

      windowTarget.dispatchEvent(move(1, 10));
      documentTarget.dispatchEvent(key("keydown", "KeyA", 20));
      detector.evaluate();
      expect(detector.getRecentPoints()).toEqual([]);
      expect(detector.getRecentKeys()).toEqual([]);

      form.dispatchEvent(move(5, 100));
      form.dispatchEvent(key("keydown", "KeyA", 110));
      detector.evaluate();
      expect(detector.getRecentPoints().map((s) => s.x)).toEqual([5]);
      expect(detector.getRecentKeys()).toHaveLength(1);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("re-attach después de start desengancha los listeners anteriores", () => {
    const formA = new EventTarget();
    const formB = new EventTarget();
    const detector = new IsThatAnAI({ now: () => 0 });
    detector.attachTo(formA);
    detector.start();
    formA.dispatchEvent(move(1, 10));
    detector.evaluate();
    expect(detector.getRecentPoints()).toHaveLength(1);

    detector.attachTo(formB); // aún iniciado
    formA.dispatchEvent(move(2, 20));
    formB.dispatchEvent(move(3, 30));
    detector.evaluate();
    expect(detector.getRecentPoints().map((s) => s.x)).toEqual([3]);

    detector.attachTo(formB); // idempotente
    formB.dispatchEvent(move(4, 40));
    detector.evaluate();
    expect(detector.getRecentPoints().map((s) => s.x)).toEqual([3, 4]);
    detector.stop();
  });

  it("start() sin attachTo sigue usando window/document", () => {
    const { windowTarget, documentTarget, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: () => 0 });
      detector.start();
      windowTarget.dispatchEvent(move(9, 10));
      documentTarget.dispatchEvent(key("keydown", "KeyA", 20));
      detector.evaluate();
      expect(detector.getRecentPoints().map((s) => s.x)).toEqual([9]);
      expect(detector.getRecentKeys()).toHaveLength(1);
      detector.stop();
    } finally {
      restore();
    }
  });

  it("es SSR-safe: attaching a un EventTarget sin window/document no lanza", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      "const target = new EventTarget();",
      "const detector = new IsThatAnAI();",
      "detector.attachTo(target);",
      "detector.start();",
      "detector.evaluate();",
      "detector.stop();",
      "console.log(JSON.stringify({ verdict: detector.getVerdict(), profile: detector.getDeviceProfile() }));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout).trim())).toEqual({
      verdict: MEASURING,
      profile: "desktop",
    });
  });

  it("rechaza targets que no son EventTarget", () => {
    const detector = new IsThatAnAI();
    expect(() => detector.attachTo(null as unknown as EventTarget)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Default behavior: idéntico al scoring histórico (6 decimales)
// ---------------------------------------------------------------------------

describe("comportamiento por defecto inalterado", () => {
  it("el score del detector coincide exactamente con ScoreComputer sin configurar", () => {
    const { windowTarget, clock, restore } = fakeDom();
    try {
      const detector = new IsThatAnAI({ now: clock });
      detector.start();
      const samples = straightSamples(30);
      dispatchAll(
        windowTarget,
        samples.map((s) => move(s.x, s.t)),
      );
      detector.evaluate();

      const expected = new ScoreComputer().evaluate(samples, 29 * 60).score;
      expect(detector.getVerdict().score).toBe(expected);
      expect(detector.getConfig().combination).toBe("weighted");
      expect(detector.getConfig().accessibilityProtection).toBe(false);
      detector.stop();
    } finally {
      restore();
    }
  });
});
