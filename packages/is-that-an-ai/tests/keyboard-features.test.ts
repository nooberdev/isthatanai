import { describe, expect, it } from "bun:test";
import type { InputSample, KeySample } from "../src/index";
import {
  computeKeyboardScore,
  EXTREME_EXACT_RHYTHM,
  EXTREME_INTERVAL_REGULARITY,
  extractKeyboardFeatures,
  hasKeyboardEvidence,
  KEYBOARD_FEATURE_WEIGHTS,
  keyboardExactRhythm,
  keyboardHoldRegularity,
  keyboardNoPauses,
  keyboardTextWithoutKeydown,
  keyboardWindowMs,
  MIN_HOLD_MS,
  MIN_KEY_WINDOW_MS,
  ORPHAN_TEXT_MIN_INPUTS,
  ORPHAN_TEXT_RATIO,
  ScoreComputer,
} from "../src/index";

function key(seq: number, t: number, kind: 0 | 1, category = 0): KeySample {
  return { seq, t, kind, category, trusted: 1 };
}

function input(seq: number, t: number, inputType: InputSample["inputType"]): InputSample {
  return { seq, t, kind: 0, inputType, trusted: 1 };
}

/** Secuencia de pulsaciones con intervalos/hold dados (un par por pulsación). */
function keysFrom(intervals: number[], holds: number[]): KeySample[] {
  const out: KeySample[] = [];
  let t = 0;
  let seq = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    out.push(key(++seq, t, 0));
    out.push(key(++seq, t + holds[i], 1));
    t += intervals[i];
  }
  return out;
}

/** Perfil del E2E: letras con delays 70-200ms y keyup inmediato (CDP). */
function e2eHumanKeys(count: number, hold = 1): KeySample[] {
  const delays = Array.from({ length: count }, (_, i) => 70 + ((i * 47) % 131));
  return keysFrom(delays, Array(count).fill(hold));
}

describe("medidas puras de teclado", () => {
  it("humano con pausas y errores puntúa bajo", () => {
    const intervals = Array.from(
      { length: 20 },
      (_, i) => 55 + ((i * 41) % 130) + (i % 5 === 3 ? 750 : 0),
    );
    const holds = Array.from({ length: 20 }, (_, i) => 45 + ((i * 23) % 90));
    const keys = keysFrom(intervals, holds);
    // Dos errores humanos, muy separados entre sí.
    const backs = [
      key(100, 1600, 0, 3),
      key(101, 1645, 1, 3),
      key(102, 3600, 0, 3),
      key(103, 3642, 1, 3),
    ];
    const samples = [...keys, ...backs].sort((a, b) => a.t - b.t || a.kind - b.kind);

    expect(hasKeyboardEvidence(samples, [])).toBe(true);
    const features = extractKeyboardFeatures(samples, []);
    expect(computeKeyboardScore(features)).toBeLessThan(0.3);
  });

  it("bot con intervalos exactos de 60ms y pulsaciones de 90ms puntúa alto", () => {
    const keys = keysFrom(Array(60).fill(60), Array(60).fill(90));
    expect(hasKeyboardEvidence(keys, [])).toBe(true);
    const features = extractKeyboardFeatures(keys, []);
    expect(features.intervalRegularity).toBeCloseTo(1, 6);
    expect(features.holdRegularity).toBeCloseTo(1, 6);
    expect(features.noPauses).toBeCloseTo(1, 6);
    expect(features.exactRhythm).toBeCloseTo(1, 6);
    expect(computeKeyboardScore(features)).toBeGreaterThanOrEqual(0.7);
  });

  it("pegado sin keydown marca IA", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => input(i + 1, 100 + i * 100, 1));
    expect(hasKeyboardEvidence([], inputs)).toBe(true);
    const features = extractKeyboardFeatures([], inputs);
    expect(features.pasteRatio).toBeCloseTo(1, 6);
    expect(features.textWithoutKeydown).toBeCloseTo(1, 6);
    expect(computeKeyboardScore(features)).toBeGreaterThan(0.55);

    const scored = new ScoreComputer().evaluate([], 0, [], [], [], inputs);
    expect(scored.score).not.toBeNull();
    expect(new ScoreComputer().evaluate([], 0, [], [], [], inputs)).toBeDefined();
  });

  it("insertText sin keydown marca IA y con keydown cercano no", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => input(i + 1, 2000 + i * 50, 0));
    expect(keyboardTextWithoutKeydown([], inputs)).toBeCloseTo(1, 6);
    const near = key(1, 1990, 0);
    expect(keyboardTextWithoutKeydown([near], inputs)).toBeCloseTo(0, 6);

    const keys = keysFrom(
      Array.from({ length: 14 }, (_, i) => 40 + (i % 3) * 25),
      Array(14).fill(35),
    );
    const features = extractKeyboardFeatures(keys, inputs);
    expect(computeKeyboardScore(features)).toBeGreaterThan(0.55);
  });

  it("modificadores y atajos repetidos puntúan alto", () => {
    const keys: KeySample[] = [];
    let seq = 0;
    let t = 0;
    for (let i = 0; i < 8; i += 1) {
      keys.push(key(++seq, t, 0, 6)); // Ctrl down
      keys.push(key(++seq, t + 100, 0, 0)); // C down (ritmo regular de keydowns)
      keys.push(key(++seq, t + 140, 1, 0)); // C up (40ms de pulsación)
      keys.push(key(++seq, t + 150, 1, 6)); // Ctrl up
      t += 200;
    }
    const features = extractKeyboardFeatures(keys, []);
    expect(features.modifierShortcuts).toBeCloseTo(1, 6);
    expect(computeKeyboardScore(features)).toBeGreaterThan(0.55);
  });

  it("sin evidencia suficiente la señal de teclado es null y no cambia el mouse", () => {
    const fewKeys = keysFrom(Array(8).fill(60), Array(8).fill(30));
    const fewInputs = [input(1, 10, 1)];
    expect(hasKeyboardEvidence(fewKeys, fewInputs)).toBe(false);

    const computer = new ScoreComputer();
    const keyboardOnly = computer.evaluate([], 0, [], [], fewKeys, fewInputs);
    expect(keyboardOnly.score).toBeNull();
    expect(computer.getSignalScores().keyboard).toBeNull();
    expect(keyboardOnly.confidence).toBe(0);
  });

  it("el teclado se combina con las demás señales de forma extensible", () => {
    const inputs = Array.from({ length: 5 }, (_, i) => input(i + 1, 100 + i * 100, 1));
    const computer = new ScoreComputer();
    const keyboard = computer.evaluate([], 0, [], [], [], inputs);
    expect(computer.getSignalScores().keyboard).toBe(keyboard.score);
    // Las señales sin evidencia siguen siendo null.
    expect(computer.getSignalScores().mouse).toBeNull();
    expect(computer.getSignalScores().click).toBeNull();
    expect(computer.getSignalScores().scroll).toBeNull();
  });
});

describe("calibración E2E (falso positivo de teclado)", () => {
  it("hold < 20ms es artefacto de CDP, no evidencia de bot", () => {
    expect(MIN_HOLD_MS).toBe(20);
    expect(keyboardHoldRegularity(e2eHumanKeys(30, 1))).toBe(0);
    const humano = keysFrom(Array(30).fill(100), Array(30).fill(90));
    expect(keyboardHoldRegularity(humano)).toBe(1);
  });

  it("humano E2E de 20 letras 70-200ms: score < 0.35 y sin evidencia", () => {
    const keys = e2eHumanKeys(20);
    expect(keyboardWindowMs(keys)).toBeLessThan(MIN_KEY_WINDOW_MS);
    expect(hasKeyboardEvidence(keys, [])).toBe(false);
    const features = extractKeyboardFeatures(keys, []);
    expect(features.holdRegularity).toBe(0);
    expect(computeKeyboardScore(features)).toBeLessThan(0.35);

    const computer = new ScoreComputer();
    expect(computer.evaluate([], 0, [], [], keys, []).score).toBeNull();
    expect(computer.getSignalScores().keyboard).toBeNull();
  });

  it("humano E2E con ventana suficiente: keyboard medido < 0.35", () => {
    const keys = e2eHumanKeys(30);
    expect(keyboardWindowMs(keys)).toBeGreaterThanOrEqual(MIN_KEY_WINDOW_MS);
    expect(hasKeyboardEvidence(keys, [])).toBe(true);
    const computer = new ScoreComputer();
    const result = computer.evaluate([], 0, [], [], keys, []);
    expect(result.score).not.toBeNull();
    expect(result.score as number).toBeLessThan(0.35);
    expect(computer.getSignalScores().keyboard as number).toBeLessThan(0.35);
  });

  it("noPauses solo aporta con >=3000ms de ventana o >=24 keydowns", () => {
    expect(keyboardNoPauses(e2eHumanKeys(20))).toBe(0);
    expect(keyboardNoPauses(keysFrom(Array(60).fill(60), Array(60).fill(90)))).toBe(1);
  });

  it("6 insertFromPaste sin texto correspondiente dan teclado alto", () => {
    const inputs = Array.from({ length: 6 }, (_, i) => input(i + 1, 100 + i * 80, 1));
    const features = extractKeyboardFeatures([], inputs);
    expect(features.pasteRatio).toBe(1);
    expect(features.textWithoutKeydown).toBe(1);
    expect(computeKeyboardScore(features)).toBeGreaterThan(0.6);
    const computer = new ScoreComputer();
    expect(computer.evaluate([], 0, [], [], [], inputs).score as number).toBeGreaterThan(0.6);
  });

  it("solo un ritmo casi perfecto suma: 60ms fijos vs 70-200ms aleatorios", () => {
    expect(KEYBOARD_FEATURE_WEIGHTS.intervalRegularity).toBe(0.3);
    const bot = keysFrom(Array(60).fill(60), Array(60).fill(90));
    const humano = e2eHumanKeys(30);
    expect(extractKeyboardFeatures(bot, []).intervalRegularity).toBeCloseTo(1, 6);
    expect(extractKeyboardFeatures(humano, []).intervalRegularity).toBeLessThan(0.35);
  });
});

describe("flota de teclado de agente (evidencia en pocos segundos)", () => {
  const type60 = keysFrom(Array(40).fill(60), Array(40).fill(90));
  const type16 = keysFrom(Array(40).fill(16), Array(40).fill(16));
  const fill6 = Array.from({ length: 6 }, (_, i) => input(i + 1, 100 + i * 50, 0));
  const fill1 = [input(1, 100, 0)];
  const paste8 = Array.from({ length: 8 }, (_, i) => input(i + 1, 100 + i * 50, 1));
  const humanizado = keysFrom(
    Array.from({ length: 40 }, (_, i) => 60 + ((i * 37) % 90) + (i % 9 === 4 ? 900 : 0)),
    Array.from({ length: 40 }, (_, i) => 60 + ((i * 29) % 120)),
  );
  const humanoPausas = keysFrom(
    Array.from({ length: 30 }, (_, i) => 55 + ((i * 41) % 130) + (i % 5 === 3 ? 750 : 0)),
    Array.from({ length: 30 }, (_, i) => 45 + ((i * 23) % 90)),
  );

  function scoreOf(keys: KeySample[], inputs: InputSample[]): number | null {
    return new ScoreComputer().evaluate([], 0, [], [], keys, inputs).score;
  }

  it("type() 40 teclas cada 60ms: evidencia por ritmo extremo aunque la ventana sea corta", () => {
    expect(keyboardWindowMs(type60)).toBeLessThan(3000);
    expect(keyboardExactRhythm(type60)).toBeGreaterThanOrEqual(EXTREME_EXACT_RHYTHM);
    expect(hasKeyboardEvidence(type60, [])).toBe(true);
    expect(scoreOf(type60, [])).toBeCloseTo(1, 3);
  });

  it("type() 40 teclas cada 16ms con hold 16ms: evidencia por ritmo extremo", () => {
    expect(keyboardWindowMs(type16)).toBeLessThan(1000);
    expect(extractKeyboardFeatures(type16, []).holdRegularity).toBe(0);
    expect(hasKeyboardEvidence(type16, [])).toBe(true);
    expect(scoreOf(type16, [])).toBeCloseTo(0.786, 3);
  });

  it("fill() con 6 insertText sin keydown: evidencia por texto huérfano", () => {
    expect(ORPHAN_TEXT_MIN_INPUTS).toBe(3);
    expect(ORPHAN_TEXT_RATIO).toBe(0.6);
    expect(keyboardTextWithoutKeydown([], fill6)).toBe(1);
    expect(hasKeyboardEvidence([], fill6)).toBe(true);
    expect(scoreOf([], fill6)).toBeCloseTo(0.567, 3);
  });

  it("fill() de una sola mutación no abre evidencia (coste de no guardar longitud)", () => {
    expect(keyboardTextWithoutKeydown([], fill1)).toBe(1);
    expect(hasKeyboardEvidence([], fill1)).toBe(false);
    expect(scoreOf([], fill1)).toBeNull();
  });

  it("Ctrl+V con 8 insertFromPaste sigue abriendo evidencia por pegado", () => {
    expect(hasKeyboardEvidence([], paste8)).toBe(true);
    expect(scoreOf([], paste8)).toBeCloseTo(0.639, 3);
  });

  it("agente humanizado con jitter puntúa bajo", () => {
    const features = extractKeyboardFeatures(humanizado, []);
    expect(features.exactRhythm).toBeLessThan(EXTREME_EXACT_RHYTHM);
    expect(features.intervalRegularity).toBeLessThan(EXTREME_INTERVAL_REGULARITY);
    expect(scoreOf(humanizado, []) as number).toBeLessThan(0.4);
  });

  it("humano 30 con pausas no abre la vía de ritmo extremo", () => {
    const features = extractKeyboardFeatures(humanoPausas, []);
    expect(features.intervalRegularity).toBeCloseTo(0, 6);
    expect(features.exactRhythm).toBeLessThan(EXTREME_EXACT_RHYTHM);
    // Su evidencia viene solo de la ventana larga, no del patrón extremo.
    expect(hasKeyboardEvidence(humanoPausas, [])).toBe(true);
    expect(scoreOf(humanoPausas, []) as number).toBeLessThan(0.4);
  });

  it("la vía extrema exige al menos 12 keydowns", () => {
    const shortBot = keysFrom(Array(8).fill(60), Array(8).fill(90));
    expect(keyboardExactRhythm(shortBot)).toBe(1);
    expect(hasKeyboardEvidence(shortBot, [])).toBe(false);
  });
});
