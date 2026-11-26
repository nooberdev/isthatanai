import { describe, expect, it } from "bun:test";
import { extractMouseFeatures, type MouseFeatures } from "../src/features/mouse";
import { t } from "../src/i18n";
import { translateReasons } from "../src/i18n/reason-translator";
import {
  AI_CORE,
  AI_MIN,
  computeScore,
  doubtFor,
  EMA_ALPHA,
  HUMAN_CORE,
  HUMAN_MAX,
  ScoreComputer,
  scoreReasons,
} from "../src/scoring/score";
import { weights } from "../src/scoring/weights";
import type { PointerSample } from "../src/types";

function sample(seq: number, x: number, y: number, t: number): PointerSample {
  return { seq, x, y, t, kind: 0, pointerType: 0, trusted: 1 };
}

/** Secuencia recta: n pasos de (10, yStep) cada dt ms. */
function straightLine(n: number, yStep = 0, dt = 60): PointerSample[] {
  return Array.from({ length: n }, (_, i) => sample(i + 1, i * 10, i * yStep, i * dt));
}

/** Secuencia zigzag: dx = 10 constante, dy alterna 0/30. */
function zigzagLine(n: number): PointerSample[] {
  return Array.from({ length: n }, (_, i) => sample(i + 1, i * 10, (i % 2) * 30, i * 60));
}

const HUMAN_KEYS = new Set(["overshoot", "turnSmoothness"]);
const RISK_SUM = Object.entries(weights).reduce(
  (acc, [k, w]) => acc + (HUMAN_KEYS.has(k) ? 0 : w),
  0,
);
const HUMAN_SUM = Object.entries(weights).reduce(
  (acc, [k, w]) => acc + (HUMAN_KEYS.has(k) ? w : 0),
  0,
);

function featuresAll(value: number): MouseFeatures {
  return Object.fromEntries(Object.keys(weights).map((key) => [key, value])) as MouseFeatures;
}

function featuresHuman(): MouseFeatures {
  // Ninguna medida de riesgo supera el umbral: valores 0 en IA y 1 en humano.
  return Object.fromEntries(
    Object.keys(weights).map((key) => [key, HUMAN_KEYS.has(key) ? 1 : 0]),
  ) as MouseFeatures;
}

function featuresNoRisk(): MouseFeatures {
  return Object.fromEntries(Object.keys(weights).map((key) => [key, 0])) as MouseFeatures;
}

function featuresMixed(): MouseFeatures {
  return Object.fromEntries(
    Object.keys(weights).map((key) => [key, key === "straightness" || HUMAN_KEYS.has(key) ? 1 : 0]),
  ) as MouseFeatures;
}

describe("computeScore", () => {
  it("medidas de riesgo en 1 -> score alto", () => {
    expect(computeScore(featuresAll(1))).toBeCloseTo(RISK_SUM, 6);
  });

  it("medidas humanas en 1 -> score bajo", () => {
    expect(computeScore(featuresNoRisk())).toBeCloseTo(HUMAN_SUM, 6);
  });

  it("ponderado: score entre 0 y 1 para valores mixtos", () => {
    const score = computeScore(featuresMixed());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("el puntaje usa los pesos documentados", () => {
    // media ponderada normalizada por la suma de pesos
    expect(computeScore(featuresAll(1))).toBeCloseTo(RISK_SUM, 6);
    expect(Object.values(weights).reduce((acc, w) => acc + w, 0)).toBeGreaterThan(0);
  });
});

describe("doubtFor", () => {
  it("exporta los núcleos y umbrales del modificador de duda", () => {
    expect(HUMAN_CORE).toBe(0.15);
    expect(AI_CORE).toBe(0.85);
    expect(HUMAN_MAX).toBe(0.25);
    expect(AI_MIN).toBe(0.55);
  });

  it("measuring (o sin evidencia) -> doubt 1", () => {
    expect(doubtFor("measuring", null)).toBe(1);
    expect(doubtFor("human", null)).toBe(1);
    expect(doubtFor("ai", null)).toBe(1);
  });

  it("humano convincente -> doubt 0; humano raro -> doubt alto", () => {
    expect(doubtFor("human", 0.1)).toBe(0);
    expect(doubtFor("human", HUMAN_CORE)).toBe(0);
    expect(doubtFor("human", 0.32)).toBeCloseTo((0.32 - HUMAN_CORE) / (AI_MIN - HUMAN_CORE), 6);
    expect(doubtFor("human", AI_MIN)).toBe(1);
  });

  it("IA justo sobre el umbral -> doubt alto; IA obvio -> doubt 0", () => {
    expect(doubtFor("ai", AI_MIN + 0.01)).toBeCloseTo(
      (AI_CORE - (AI_MIN + 0.01)) / (AI_CORE - AI_MIN),
      6,
    );
    expect(doubtFor("ai", AI_MIN)).toBe(1);
    expect(doubtFor("ai", AI_CORE)).toBe(0);
    expect(doubtFor("ai", 0.95)).toBe(0);
  });
});

describe("scoreReasons", () => {
  it("devuelve strings legibles, máximo 3", () => {
    const reasons = scoreReasons(featuresAll(1));
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(typeof reason).toBe("string");
  });

  it("cambia según las medidas", () => {
    const ai = scoreReasons(featuresAll(1));
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((r) => typeof r === "string")).toBe(true);
  });

  it("si ninguna medida de riesgo pasa el umbral devuelve []", () => {
    expect(scoreReasons(featuresHuman())).toEqual([]);
    expect(translateReasons(scoreReasons(featuresMixed(), 1), "en")).toEqual([
      t("reason.mouse.straightnessHigh", "en"),
    ]);
  });
});

describe("ScoreComputer", () => {
  it("evidencia insuficiente -> score null y confianza 0", () => {
    const computer = new ScoreComputer();
    expect(computer.evaluate([], 100)).toEqual({ score: null, confidence: 0, reasons: [] });
    // menos de 10 muestras
    expect(computer.evaluate(straightLine(5), 600).score).toBeNull();
    // ventana corta
    expect(computer.evaluate(straightLine(30), 300).score).toBeNull();
  });

  it("evidencia suficiente -> score número, confianza > 0", () => {
    const computer = new ScoreComputer();
    const result = computer.evaluate(straightLine(30), 30 * 60);
    expect(result.score).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it("EMA: la segunda evaluación suaviza hacia el nuevo raw", () => {
    const computer = new ScoreComputer();
    const first = computer.evaluate(zigzagLine(30), 30 * 60);
    const rawY = computeScore(extractMouseFeatures(straightLine(30)));
    const second = computer.evaluate(straightLine(30), 30 * 60);
    expect(second.score).not.toBeNull();
    expect(second.score).toBeCloseTo(
      EMA_ALPHA * rawY + (1 - EMA_ALPHA) * (first.score as number),
      6,
    );
  });

  it("confianza crece con segmentos y ventana", () => {
    const computer = new ScoreComputer();
    const few = computer.evaluate(straightLine(21, 0, 100), 2100).confidence;
    const many = computer.evaluate(straightLine(40), 30 * 60).confidence;
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThanOrEqual(1);
  });
});
