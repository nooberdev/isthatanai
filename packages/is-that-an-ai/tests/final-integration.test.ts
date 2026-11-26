// Checklist final (71 ítems): integración de touch/atención, coherencia
// detallada, entorno, privacidad, recalibración y medidas finales opt-in.
// Todas las pruebas son deterministas, sin DOM real, sin red y sin storage.

import { describe, expect, it } from "bun:test";
import { applyCalibration, calibrationFromSession } from "../src/calibration/recalibrate";
import { type AttentionSample, createAttentionCollector } from "../src/collectors/attention";
import { createTouchCollector, type TouchSample } from "../src/collectors/touch";
import { evaluateCoherenceDetailed } from "../src/core/coherence";
import { IsThatAnAI } from "../src/core/detector";
import { evaluateEnvironment } from "../src/core/environment";
import { ATTENTION_FEATURE_WEIGHTS, extractAttentionFeatures } from "../src/features/attention";
import { extractTouchFeatures, TOUCH_FEATURE_WEIGHTS } from "../src/features/touch";
import { ADVANCED_MAX_SHARE, ScoreComputer } from "../src/scoring/score";
import type { DetectorOptions, PointerSample } from "../src/types";
import { aggregatesOnlyStats, doNotTrack, roundTiming } from "../src/utils/privacy-shape";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function fakeEvent(type: string, props: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

function pointerEvent(
  type: string,
  x: number,
  t: number,
  pointerType = "mouse",
  extra: Record<string, unknown> = {},
): Event {
  return fakeEvent(type, {
    clientX: x,
    clientY: x * 2,
    timeStamp: t,
    pointerType,
    isTrusted: true,
    ...extra,
  });
}

function session<T>(
  options: DetectorOptions,
  body: (detector: IsThatAnAI, target: EventTarget) => T,
): T {
  const detector = new IsThatAnAI({ now: () => 0, ...options });
  const target = new EventTarget();
  detector.attachTo(target);
  detector.start();
  try {
    return body(detector, target);
  } finally {
    detector.stop();
  }
}

function mouseSamples(count: number, dt = 60): PointerSample[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i * 10 + (i % 3 === 0 ? 4 : -2);
    return {
      seq: i + 1,
      x,
      // El colector guarda `clientY = clientX * 2` (ver `pointerEvent`).
      y: x * 2,
      t: i * dt,
      kind: 0,
      pointerType: 0,
      trusted: 1,
    };
  });
}

const ORIGINAL_STAT_KEYS = [
  "sampleCount",
  "droppedCount",
  "eventsPerSecond",
  "bufferFill",
  "trustedRatio",
  "lastEventAt",
  "clickCount",
  "scrollCount",
];

// ---------------------------------------------------------------------------
// SSR y defaults (nada se activa decorativamente)
// ---------------------------------------------------------------------------

describe("checklist final: SSR y defaults", () => {
  it("importar y construir sin DOM no toca globals ni activa colectores", () => {
    expect(() => new IsThatAnAI()).not.toThrow();
    const d = new IsThatAnAI({ advancedMeasures: true, aggregatesOnly: false });
    expect(d.getPrivacyMode()).toBe("full");
    expect(d.getCalibration()).toBeNull();
    expect(d.getRecentTouches()).toEqual([]);
    expect(d.getRecentAttention()).toEqual([]);
    expect(d.getTouchFeatures()).toBeNull();
    expect(d.getAttentionFeatures()).toBeNull();
    expect(d.isAdvancedMeasures()).toBe(true);
  });

  it("los defaults conservan las formas enumerables y el score fijado", () => {
    const d = new IsThatAnAI({ now: () => 0 });
    expect(Object.keys(d.getStats())).toEqual(ORIGINAL_STAT_KEYS);
    expect(Object.keys(d.getSignalScores())).toEqual(["mouse", "click", "scroll"]);
    const samples = mouseSamples(30);
    session({ now: () => 0 }, (detector, target) => {
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      detector.evaluate();
      const expected = new ScoreComputer().evaluate(samples, 29 * 60).score;
      expect(detector.getVerdict().score).toBe(expected);
      const risk = detector.getScoreBreakdown().riskEvidence;
      // Los campos nuevos existen pero NO son enumerables.
      expect(Object.keys(risk)).toEqual([
        "coherence",
        "injection",
        "humanization",
        "formulaRhythm",
        "declaredVsBehavior",
        "replay",
        "surprise",
        "overall",
      ]);
      expect(risk.coherenceDetailed).not.toBeNull();
      expect(risk.environment).not.toBeNull();
    });
    void d;
  });

  it("opciones hostiles vuelven al default sin lanzar", () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("hostil");
        },
      },
    );
    expect(() => new IsThatAnAI(hostile as unknown as DetectorOptions)).not.toThrow();
    expect(() => new IsThatAnAI(null as unknown as DetectorOptions)).not.toThrow();
    expect(
      () => new IsThatAnAI({ touch: "x", attention: 3 } as unknown as DetectorOptions),
    ).not.toThrow();
    const d = new IsThatAnAI({
      advancedMeasures: "yes",
      aggregatesOnly: 1,
    } as unknown as DetectorOptions);
    expect(d.isAdvancedMeasures()).toBe(false);
    expect(d.getPrivacyMode()).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// Touch + atención (colectores y features reales)
// ---------------------------------------------------------------------------

describe("checklist final: touch y atención", () => {
  it("el colector táctil captura muestras, expone features y cuenta no enumerable", () => {
    session({ touch: { bufferSize: 16 } }, (d, target) => {
      target.dispatchEvent(
        pointerEvent("pointerdown", 120, 100, "touch", { pressure: 0.6, radiusX: 9, radiusY: 7 }),
      );
      target.dispatchEvent(
        pointerEvent("pointermove", 160, 140, "touch", { pressure: 0.4, radiusX: 8, radiusY: 6 }),
      );
      target.dispatchEvent(pointerEvent("pointerup", 160, 190, "touch"));
      // Un clic falso de mouse NO debe añadir muestras táctiles.
      target.dispatchEvent(pointerEvent("pointerdown", 10, 200, "mouse"));
      d.evaluate();

      const touches = d.getRecentTouches();
      expect(touches.length).toBe(3);
      expect(d.getRecentTouches(1).length).toBe(2);
      expect(touches.every((s) => s.pointerType === 2)).toBe(true);
      const features = d.getTouchFeatures();
      expect(features).not.toBeNull();
      expect(Object.keys(features ?? {}).length).toBeGreaterThan(0);
      for (const value of Object.values(features ?? {})) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      const stats = d.getStats() as unknown as Record<string, number>;
      expect(stats.touchCount).toBe(3);
      expect(Object.keys(d.getStats())).toEqual(ORIGINAL_STAT_KEYS);
    });
  });

  it("el colector de atención captura visibilidad/foco y expone features", () => {
    session({ attention: { bufferSize: 16 } }, (d, target) => {
      target.dispatchEvent(fakeEvent("visibilitychange", { hidden: true, timeStamp: 10 }));
      target.dispatchEvent(fakeEvent("focus", { timeStamp: 20, isTrusted: true }));
      target.dispatchEvent(fakeEvent("blur", { timeStamp: 30, isTrusted: true }));
      target.dispatchEvent(fakeEvent("resize", { timeStamp: 40, isTrusted: true }));
      d.evaluate();

      const attention = d.getRecentAttention();
      expect(attention.length).toBe(4);
      expect(d.getRecentAttention(2).length).toBe(2);
      expect(d.getAttentionFeatures()).not.toBeNull();
      expect(Object.keys(d.getAttentionFeatures() ?? {}).length).toBeGreaterThan(0);
      const stats = d.getStats() as unknown as Record<string, number>;
      expect(stats.attentionCount).toBe(4);
      expect(Object.keys(d.getStats())).toEqual(ORIGINAL_STAT_KEYS);
    });
  });

  it("los módulos aislados respetan los contratos y son SSR-safe", () => {
    const target = new EventTarget();
    const touches = createTouchCollector({ target, now: () => 0, bufferSize: 4 });
    const attention = createAttentionCollector({ target, now: () => 0, bufferSize: 4 });
    touches.attach();
    attention.attach();
    target.dispatchEvent(pointerEvent("pointerdown", 5, 10, "touch"));
    target.dispatchEvent(fakeEvent("focus", { timeStamp: 20, isTrusted: true }));
    const touchSamples: TouchSample[] = touches.getSamples();
    const attentionSamples: AttentionSample[] = attention.getSamples();
    expect(touchSamples.length).toBe(1);
    expect(attentionSamples.length).toBe(1);
    expect(Object.keys(extractTouchFeatures(touchSamples)).length).toBeGreaterThan(0);
    expect(Object.keys(extractAttentionFeatures(attentionSamples)).length).toBeGreaterThan(0);
    expect(Object.keys(TOUCH_FEATURE_WEIGHTS).length).toBeGreaterThan(0);
    expect(Object.keys(ATTENTION_FEATURE_WEIGHTS).length).toBeGreaterThan(0);
    touches.detach();
    attention.detach();
    touches.clear();
    attention.clear();
  });
});

// ---------------------------------------------------------------------------
// Coherencia detallada y entorno (aditivas, sin score)
// ---------------------------------------------------------------------------

describe("checklist final: coherencia detallada y entorno", () => {
  it("ambas funciones puras acotan resultados hostiles a [0,1]", () => {
    const samples = mouseSamples(20);
    const detailed = evaluateCoherenceDetailed({
      points: samples,
      clicks: [],
      scrolls: [],
      keys: [],
      inputs: [],
    });
    for (const value of Object.values(detailed)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    const environment = evaluateEnvironment({
      points: samples,
      clicks: [],
      scrolls: [],
      keys: [],
      inputs: [],
      hints: { webdriver: true, screenWidth: 800, screenHeight: 600 },
    });
    expect(environment.automatedBrowser).toBe(1);
    expect(environment.oddViewport).toBe(1);
  });

  it("se integran en riskEvidence sin alterar score, veredicto ni enumerables", () => {
    const samples = mouseSamples(30);
    session({ now: () => 0 }, (d, target) => {
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      d.evaluate();
      const breakdown = d.getScoreBreakdown();
      const risk = breakdown.riskEvidence as unknown as Record<string, unknown>;
      expect(risk.coherenceDetailed).toBeTypeOf("object");
      expect(risk.environment).toBeTypeOf("object");
      expect(Object.keys(breakdown)).not.toContain("privacyMode");
      expect(Object.keys(breakdown)).not.toContain("advancedMeasuresApplied");
      expect(d.getVerdict().score).toBe(new ScoreComputer().evaluate(samples, 29 * 60).score);
    });
  });
});

// ---------------------------------------------------------------------------
// Privacidad: modo agregados y "No rastrear"
// ---------------------------------------------------------------------------

describe("checklist final: privacidad", () => {
  it("roundTiming y aggregatesOnlyStats son defensivos y no filtran marcas", () => {
    expect(roundTiming(123.4)).toBe(100);
    expect(roundTiming(Number.NaN)).toBe(0);
    expect(roundTiming(-5)).toBe(0);
    expect(roundTiming(0.73, 0.05)).toBe(0.75);
    const projected = aggregatesOnlyStats({
      sampleCount: 12.7,
      lastEventAt: 9999,
      trustedRatio: 0.333,
      secret: 1,
      key: "a",
    });
    expect(projected.sampleCount).toBe(12);
    // Las razones/tasas no son conteos ni duraciones: se descartan (fail-closed).
    expect(projected).not.toHaveProperty("trustedRatio");
    expect(projected).not.toHaveProperty("lastEventAt");
    expect(projected).not.toHaveProperty("secret");
    expect(projected).not.toHaveProperty("key");
  });

  it("aggregatesOnly redondea scores y elimina marcas crudas sin cambiar el veredicto", () => {
    const samples = mouseSamples(30);
    const fullScore = new ScoreComputer().evaluate(samples, 29 * 60).score;
    session({ now: () => 0, aggregatesOnly: true }, (d, target) => {
      expect(d.getPrivacyMode()).toBe("aggregates");
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      d.evaluate();
      expect(d.getVerdict().score).toBe(fullScore);
      const stats = d.getStats() as unknown as Record<string, unknown>;
      expect(stats).not.toHaveProperty("lastEventAt");
      expect(Object.keys(stats).every((k) => k !== "lastEventAt")).toBe(true);
      for (const value of Object.values(d.getSignalScores())) {
        if (value === null) continue;
        expect(Math.abs(value * 20 - Math.round(value * 20))).toBeLessThan(1e-9);
      }
      expect(Object.keys(d.getSignalScores())).toEqual(["mouse", "click", "scroll"]);
    });
  });

  it("doNotTrack detecta la preferencia solo en runtime", () => {
    const globals = globalThis as { navigator?: unknown };
    const previous = globals.navigator;
    let restored = true;
    try {
      Object.defineProperty(globals, "navigator", {
        value: { doNotTrack: "1" },
        configurable: true,
      });
      expect(doNotTrack()).toBe(true);
      const d = new IsThatAnAI({ now: () => 0 });
      expect(d.getPrivacyMode()).toBe("full"); // no se consulta en el constructor
      d.start();
      expect(d.getPrivacyMode()).toBe("aggregates");
      d.stop();
    } catch {
      restored = false;
    } finally {
      if (previous === undefined) delete globals.navigator;
      else Object.defineProperty(globals, "navigator", { value: previous, configurable: true });
    }
    expect(restored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recalibración (acotada, en memoria, sin veredicto forzado)
// ---------------------------------------------------------------------------

describe("checklist final: recalibración", () => {
  it("calibrationFromSession y applyCalibration respetan cotas", () => {
    const sessionData = {
      keys: Array.from({ length: 14 }, (_, i) => ({
        t: i * 50,
        kind: 0,
        category: 0,
        trusted: 1,
      })),
    };
    const result = calibrationFromSession(sessionData);
    expect(result.applied).toBe(true);
    for (const factor of Object.values(result.adjustments)) {
      expect(factor).toBeGreaterThanOrEqual(0.8);
      expect(factor).toBeLessThanOrEqual(1.2);
    }
    const applied = applyCalibration({ pauseMs: 1000, rhythmTolerance: 0.5 }, result);
    expect(applied.pauseMs).toBeGreaterThanOrEqual(400);
    expect(applied.pauseMs).toBeLessThanOrEqual(3000);
    expect(applied.rhythmTolerance).toBeGreaterThanOrEqual(0.1);
    expect(applied.rhythmTolerance).toBeLessThanOrEqual(0.9);
  });

  it("recalibrateFromSession guarda copia acotada y NO altera el score", () => {
    const samples = mouseSamples(30);
    const fastSession = {
      keys: Array.from({ length: 14 }, (_, i) => ({ t: i * 45, kind: 0, category: 0 })),
    };
    session({ now: () => 0 }, (d, target) => {
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      d.evaluate();
      const before = d.getVerdict();

      const result = d.recalibrateFromSession(fastSession);
      expect(result.applied).toBe(true);
      expect(d.getCalibration()).not.toBeNull();
      // La copia pública no puede mutar el estado interno.
      (result.adjustments as Record<string, number>).pauseMs = 999999;
      const stored = d.getCalibration()?.adjustments as Record<string, number> | undefined;
      expect(stored?.pauseMs).toBeLessThan(1e6);

      d.evaluate();
      expect(d.getVerdict().score).toBe(before.score);
      expect(d.getVerdict().state).toBe(before.state);

      d.resetCalibration();
      expect(d.getCalibration()).toBeNull();
    });
  });

  it("sesiones hostiles o vacías fallan cerrado", () => {
    const d = new IsThatAnAI();
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("hostil");
        },
      },
    );
    expect(() => d.recalibrateFromSession(hostile)).not.toThrow();
    // Sin evidencia_utilizable: fail closed, `applied:false` y sin ajustes.
    expect(d.getCalibration()?.applied).toBe(false);
    expect(Object.keys(d.getCalibration()?.adjustments ?? {})).toEqual([]);
    d.recalibrateFromSession({ keys: [{ t: "x", kind: 0 }] });
    expect(d.getCalibration()?.applied).toBe(false);
    expect(() => d.resetCalibration()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Medidas finales OPT-IN: cambio medible y acotado; default intacto
// ---------------------------------------------------------------------------

describe("checklist final: advancedMeasures (opt-in)", () => {
  it("sin opt-in el score es bit a bit el histórico", () => {
    const samples = mouseSamples(40, 45);
    const plain = new ScoreComputer();
    const configured = new ScoreComputer();
    configured.configure({ advancedMeasures: false });
    expect(plain.evaluate(samples, 39 * 45)).toEqual(configured.evaluate(samples, 39 * 45));
    expect(plain.getScoringSnapshot().advancedApplied).toBe(false);
  });

  it("con opt-in el score cambia de forma medible y acotada", () => {
    const samples = mouseSamples(40, 45);
    const base = new ScoreComputer().evaluate(samples, 39 * 45).score;
    const advanced = new ScoreComputer();
    advanced.configure({ advancedMeasures: true });
    const evidence = advanced.evaluate(samples, 39 * 45);
    expect(evidence.score).not.toBeNull();
    expect(advanced.getScoringSnapshot().advancedApplied).toBe(true);
    expect(advanced.getScoringSnapshot().advancedShare).toBe(ADVANCED_MAX_SHARE);
    expect(Math.abs((evidence.score as number) - (base as number))).toBeGreaterThan(1e-9);
    expect(Math.abs((evidence.score as number) - (base as number))).toBeLessThanOrEqual(
      ADVANCED_MAX_SHARE + 1e-9,
    );
  });

  it("el detector propaga el opt-in y conserva las formas", () => {
    const samples = mouseSamples(40, 45);
    const baseScore = session({ now: () => 0 }, (d, target) => {
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      d.evaluate();
      return d.getVerdict().score;
    });
    const advanced = session({ now: () => 0, advancedMeasures: true }, (d, target) => {
      for (const s of samples) target.dispatchEvent(pointerEvent("pointermove", s.x, s.t));
      d.evaluate();
      expect(
        (d.getScoreBreakdown() as unknown as Record<string, unknown>).advancedMeasuresApplied,
      ).toBe(true);
      expect(Object.keys(d.getScoreBreakdown())).not.toContain("advancedMeasuresApplied");
      return d.getVerdict().score;
    });
    expect(advanced).not.toBe(baseScore);
    expect(Math.abs((advanced as number) - (baseScore as number))).toBeLessThanOrEqual(
      ADVANCED_MAX_SHARE + 1e-9,
    );
  });
});
