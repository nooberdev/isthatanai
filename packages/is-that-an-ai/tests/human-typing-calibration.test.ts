import { describe, expect, it } from "bun:test";
import type { InputSample, KeySample } from "../src/index";
import {
  AGENT_KEYBOARD_REFERENCE,
  AI_MIN,
  CMU_KEYBOARD_REFERENCE,
  computeKeyboardScore,
  EXACT_RHYTHM_UNIQUE_LOW,
  extractKeyboardFeatures,
  HUMAN_MAX,
  HUMAN_PAUSE_MS,
  HUMAN_TYPING_BASELINE,
  HUMAN_UNIQUE_INTERVAL_SHARE,
  keyboardExactRhythm,
  keyboardNoPauses,
  ScoreComputer,
} from "../src/index";

// Volcado de la sesión etiquetada "humano" (calibracion-teclado(1).json).
// Solo [t, kind, category] / [t, inputType]: sin teclas, sin texto, sin red.
const KEY_TUPLES: Array<[number, 0 | 1, number]> = [
  [35716, 0, 2],
  [35810, 1, 2],
  [35825, 0, 0],
  [35935, 1, 0],
  [35997, 0, 0],
  [36108, 1, 0],
  [36263, 0, 0],
  [36372, 1, 0],
  [36544, 0, 0],
  [36638, 1, 0],
  [36778, 0, 0],
  [36872, 1, 0],
  [36967, 0, 2],
  [37028, 1, 2],
  [37216, 0, 0],
  [37294, 1, 0],
  [37310, 0, 0],
  [37436, 1, 0],
  [37497, 0, 0],
  [37544, 1, 0],
  [37747, 0, 0],
  [37810, 0, 0],
  [37826, 1, 0],
  [37889, 1, 0],
  [37919, 0, 2],
  [38028, 1, 2],
  [38169, 0, 0],
  [38233, 1, 0],
  [38263, 0, 0],
  [38373, 0, 0],
  [38435, 1, 0],
  [38529, 0, 2],
  [38544, 1, 0],
  [38622, 1, 2],
  [38779, 0, 0],
  [38825, 1, 0],
  [38935, 0, 0],
  [38997, 0, 0],
  [39014, 1, 0],
  [39107, 1, 0],
  [39216, 0, 0],
  [39358, 1, 0],
  [39451, 0, 0],
  [39560, 1, 0],
  [39950, 0, 7],
  [40075, 1, 7],
  [46763, 0, 6],
  [47013, 0, 0],
  [47107, 1, 0],
  [47186, 1, 6],
  [48013, 0, 6],
  [48326, 0, 0],
  [48450, 1, 0],
  [48513, 1, 6],
];
const INPUT_TUPLES: Array<[number, 0 | 1]> = [
  [35723, 0],
  [35831, 0],
  [36005, 0],
  [36278, 0],
  [36561, 0],
  [36785, 0],
  [36976, 0],
  [37225, 0],
  [37314, 0],
  [37502, 0],
  [37749, 0],
  [37818, 0],
  [37932, 0],
  [38183, 0],
  [38271, 0],
  [38378, 0],
  [38538, 0],
  [38781, 0],
  [38949, 0],
  [39014, 0],
  [39220, 0],
  [39457, 0],
  [39966, 0],
  [48344, 1],
];

const keys: KeySample[] = KEY_TUPLES.map(([t, kind, category], i) => ({
  seq: i + 1,
  t,
  kind,
  category: category as KeySample["category"],
  trusted: 1,
}));
const inputs: InputSample[] = INPUT_TUPLES.map(([t, inputType], i) => ({
  seq: i + 1,
  t,
  kind: 0,
  inputType: inputType as InputSample["inputType"],
  trusted: 1,
}));

function botKeys(): KeySample[] {
  const out: KeySample[] = [];
  let seq = 0;
  for (let i = 0; i < 40; i += 1) {
    out.push({ seq: ++seq, t: i * 60, kind: 0, category: 0, trusted: 1 });
    out.push({ seq: ++seq, t: i * 60 + 90, kind: 1, category: 0, trusted: 1 });
  }
  return out;
}

/** Bot con ciclo corto de delays: pocos valores distintos pese al jitter. */
function cycleKeys(): KeySample[] {
  const out: KeySample[] = [];
  const delays = [40, 65, 90];
  let seq = 0;
  let t = 0;
  for (let i = 0; i < 14; i += 1) {
    out.push({ seq: ++seq, t, kind: 0, category: 0, trusted: 1 });
    out.push({ seq: ++seq, t: t + 35, kind: 1, category: 0, trusted: 1 });
    t += delays[i % delays.length];
  }
  return out;
}

describe("calibración con sesión humana real", () => {
  it("el perfil exportado describe la sesión grabada", () => {
    expect(HUMAN_TYPING_BASELINE.label).toBe("humano");
    expect(HUMAN_TYPING_BASELINE.wpm).toBeCloseTo(45.44, 2);
    expect(HUMAN_TYPING_BASELINE.accuracy).toBeCloseTo(0.9607, 4);
    expect(HUMAN_TYPING_BASELINE.counts).toEqual({
      keyDowns: 27,
      typedInputs: 23,
      pasteInputs: 1,
    });
    expect(HUMAN_TYPING_BASELINE.interInputMs.p50).toBe(188);
    expect(HUMAN_TYPING_BASELINE.keyHoldMs.p50).toBe(94);
    expect(HUMAN_TYPING_BASELINE.longPausesMs).toContain(6813);
    expect(HUMAN_UNIQUE_INTERVAL_SHARE).toBeCloseTo(20 / 26, 6);
    expect(EXACT_RHYTHM_UNIQUE_LOW).toBeLessThan(HUMAN_UNIQUE_INTERVAL_SHARE);
  });

  it("el perfil concuerda con la referencia pública CMU y separa agentes", () => {
    // Referencia externa: 20.400 sesiones de contraseña (mediana hold 86ms,
    // down-down 191ms). Nuestra sesión real cae en la misma banda.
    expect(HUMAN_TYPING_BASELINE.keyHoldMs.p50).toBeGreaterThan(
      CMU_KEYBOARD_REFERENCE.holdMs.p50 * 0.8,
    );
    expect(HUMAN_TYPING_BASELINE.keyHoldMs.p50).toBeLessThan(CMU_KEYBOARD_REFERENCE.holdMs.p90);
    expect(HUMAN_TYPING_BASELINE.interKeyDownMs.p50).toBeGreaterThan(
      CMU_KEYBOARD_REFERENCE.keyIntervalMs.p10,
    );
    expect(HUMAN_TYPING_BASELINE.interKeyDownMs.p50).toBeLessThan(
      CMU_KEYBOARD_REFERENCE.keyIntervalMs.p50 * 1.3,
    );
    for (const agent of ["Browser Use", "Skyvern", "Manus"]) {
      expect(AGENT_KEYBOARD_REFERENCE.interKeyMs[agent]).toBeLessThan(10);
    }
  });

  it("una pausa de 1000ms observada en el humano ya no cuenta como 'sin pausas'", () => {
    expect(HUMAN_PAUSE_MS).toBe(1000);
    expect(keyboardNoPauses(keys)).toBe(0);
    expect(keyboardNoPauses(botKeys())).toBeCloseTo(1, 6);
  });

  it("repetir un intervalo por casualidad no es ritmo de máquina", () => {
    expect(keyboardExactRhythm(keys)).toBe(0);
    expect(keyboardExactRhythm(botKeys())).toBe(1);
    expect(keyboardExactRhythm(cycleKeys())).toBeGreaterThan(0.9);
  });

  it("la sesión humana queda holgadamente por debajo de HUMAN_MAX", () => {
    const score = computeKeyboardScore(extractKeyboardFeatures(keys, inputs));
    expect(score).toBeLessThan(0.2);
    expect(score).toBeLessThan(HUMAN_MAX);
    const computer = new ScoreComputer();
    const evaluated = computer.evaluate([], 0, [], [], keys, inputs);
    expect(evaluated.score as number).toBeLessThan(HUMAN_MAX);
    expect(computer.getSignalScores().keyboard as number).toBeLessThan(HUMAN_MAX);
  });

  it("la calibración no abre la puerta a bots de intervalo fijo", () => {
    const score = new ScoreComputer().evaluate([], 0, [], [], botKeys(), []).score as number;
    expect(score).toBeGreaterThanOrEqual(AI_MIN);
  });

  it("el perfil no contiene teclas ni texto, solo tiempos y conteos", () => {
    const json = JSON.stringify(HUMAN_TYPING_BASELINE);
    expect(Object.keys(HUMAN_TYPING_BASELINE)).not.toContain("keys");
    expect(Object.keys(HUMAN_TYPING_BASELINE)).not.toContain("text");
    for (const identity of ["KeyA", "Enter", "Backspace", "hola"]) {
      expect(json).not.toContain(identity);
    }
  });
});
