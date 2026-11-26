import { describe, expect, it } from "bun:test";
import {
  computeKeyboardScore,
  extractKeyboardFeatures,
  KEYBOARD_FEATURE_WEIGHTS,
  KEYBOARD_NEUTRAL,
  type KeyboardFeatures,
  keyboardArrowUsage,
  keyboardAutocompleteFalsePositive,
  keyboardCapitalization,
  keyboardEnterSubmit,
  keyboardIntervalDistribution,
  keyboardPauseAfterError,
  keyboardProgrammaticKeys,
  keyboardSelectionDeletion,
  keyboardSentenceEndPauses,
  keyboardTypingSpeed,
  keyboardWordPauses,
} from "../src/features/keyboard";
import type { InputSample, KeySample } from "../src/types";

function key(
  seq: number,
  t: number,
  kind: 0 | 1,
  category: KeySample["category"] = 0,
  trusted: 0 | 1 = 1,
): KeySample {
  return { seq, t, kind, category, trusted };
}

/** Keydowns en orden de tiempo (una categoría por posición). */
function downs(categories: number[], step: number, start = 0): KeySample[] {
  return categories.map((category, i) =>
    key(i + 1, start + i * step, 0, category as KeySample["category"]),
  );
}

function input(
  seq: number,
  t: number,
  inputType: InputSample["inputType"],
  trusted: 0 | 1 = 1,
): InputSample {
  return { seq, t, kind: 0, inputType, trusted };
}

const NEW_KEYS = [
  "intervalDistribution",
  "typingSpeed",
  "pauseAfterError",
  "wordPauses",
  "sentenceEndPauses",
  "selectionDeletion",
  "arrowUsage",
  "autocompleteFalsePositive",
  "enterSubmit",
  "capitalization",
  "programmaticKeys",
] as const;

describe("L71 · distribución del intervalo", () => {
  it("metrónomo concentrado puntúa alto, ritmo variable bajo", () => {
    expect(keyboardIntervalDistribution(downs(Array(10).fill(0), 60))).toBeCloseTo(1, 6);
    const variable = downs([0, 0, 0, 0, 0, 0, 0, 0, 0], 60).map((sample, i) => ({
      ...sample,
      t: [0, 50, 100, 300, 360, 660, 750, 830, 1080][i],
    }));
    expect(keyboardIntervalDistribution(variable)).toBeLessThan(0.3);
  });

  it("sin muestras devuelve NEUTRAL", () => {
    expect(keyboardIntervalDistribution([])).toBe(KEYBOARD_NEUTRAL);
  });
});

describe("L78 · velocidad promedio", () => {
  it("tecleo imposiblemente rápido puntúa alto, lento bajo", () => {
    expect(keyboardTypingSpeed(downs(Array(20).fill(0), 50))).toBeCloseTo(1, 6);
    expect(keyboardTypingSpeed(downs(Array(20).fill(0), 300))).toBe(0);
  });

  it("sin muestras devuelve NEUTRAL", () => {
    expect(keyboardTypingSpeed([])).toBe(KEYBOARD_NEUTRAL);
    expect(keyboardTypingSpeed(downs(Array(2).fill(0), 10))).toBe(KEYBOARD_NEUTRAL);
  });
});

describe("L83 · pausa después de un error", () => {
  it("corrección instantánea puntúa alto, pausa humana bajo", () => {
    const instant = [key(1, 1000, 0), key(2, 1100, 0, 3), key(3, 1110, 0)];
    expect(keyboardPauseAfterError(instant)).toBeCloseTo(1, 6);
    const paused = [key(1, 1000, 0), key(2, 1100, 0, 3), key(3, 1500, 0)];
    expect(keyboardPauseAfterError(paused)).toBe(0);
  });

  it("sin borrados devuelve 0", () => {
    expect(keyboardPauseAfterError(downs(Array(10).fill(0), 100))).toBe(0);
  });
});

describe("L84 · pausas entre palabras", () => {
  it("sin pausa en el espacio puntúa alto, con pausa bajo", () => {
    const bot = downs([0, 0, 2, 0, 0, 2, 0, 0], 100).map((sample, i) => ({
      ...sample,
      t: [0, 100, 200, 210, 310, 410, 420, 520][i],
    }));
    expect(keyboardWordPauses(bot)).toBeCloseTo(1, 6);
    const humanTimes = [0, 100, 200, 450, 550, 650, 900, 1000];
    const human = bot.map((sample, i) => ({ ...sample, t: humanTimes[i] }));
    expect(keyboardWordPauses(human)).toBe(0);
  });

  it("sin espacios devuelve NEUTRAL", () => {
    expect(keyboardWordPauses(downs(Array(8).fill(0), 100))).toBe(KEYBOARD_NEUTRAL);
  });
});

describe("L85 · pausas al final de frase", () => {
  it("Enter sin pausa puntúa alto, con pausa bajo", () => {
    const bot = downs([0, 0, 4, 0, 0, 4], 100).map((sample, i) => ({
      ...sample,
      t: [0, 100, 110, 210, 310, 320][i],
    }));
    expect(keyboardSentenceEndPauses(bot)).toBeCloseTo(1, 6);
    const humanTimes = [0, 100, 400, 500, 600, 900];
    const human = bot.map((sample, i) => ({ ...sample, t: humanTimes[i] }));
    expect(keyboardSentenceEndPauses(human)).toBe(0);
  });

  it("sin Enter devuelve NEUTRAL", () => {
    expect(keyboardSentenceEndPauses(downs(Array(8).fill(0), 100))).toBe(KEYBOARD_NEUTRAL);
  });
});

describe("L91 · selección y borrado", () => {
  it("borrados sin selección puntúan alto, con selección bajos", () => {
    const bot = downs([3, 3, 3], 100);
    expect(keyboardSelectionDeletion(bot)).toBeCloseTo(1, 6);
    const human = [
      key(1, 0, 0, 6),
      key(2, 10, 0, 5),
      key(3, 20, 0, 3),
      key(4, 100, 0, 6),
      key(5, 110, 0, 5),
      key(6, 120, 0, 3),
      key(7, 200, 0, 6),
      key(8, 210, 0, 5),
      key(9, 220, 0, 3),
    ];
    expect(keyboardSelectionDeletion(human)).toBe(0);
  });

  it("menos de dos borrados devuelve 0", () => {
    expect(keyboardSelectionDeletion(downs([0, 3, 0], 100))).toBe(0);
  });
});

describe("L92 · uso de flechas", () => {
  it("edición sin flechas puntúa alto, con flechas bajo", () => {
    const categories = [0, 0, 0, 3, 0, 3, 0, 3, 0, 3];
    expect(keyboardArrowUsage(downs(categories, 100))).toBeCloseTo(1, 6);
    const withArrows = [...categories, 5, 5];
    expect(keyboardArrowUsage(downs(withArrows, 100))).toBe(0);
  });

  it("sin edición o pocos datos devuelve 0", () => {
    expect(keyboardArrowUsage(downs(Array(10).fill(0), 100))).toBe(0);
    expect(keyboardArrowUsage(downs([3, 3], 100))).toBe(0);
  });
});

describe("L96 · autocompletado/contraseña (anti falso positivo)", () => {
  it("inserciones huérfanas agrupadas puntúan alto (NO bot)", () => {
    const inputs = [input(1, 100, 0), input(2, 120, 0), input(3, 140, 0)];
    expect(keyboardAutocompleteFalsePositive([], inputs)).toBeCloseTo(1, 6);
  });

  it("con keydown o pegado no es autocompletado", () => {
    const inserts = [input(1, 100, 0), input(2, 120, 0), input(3, 140, 0)];
    expect(keyboardAutocompleteFalsePositive(downs(Array(3).fill(0), 100), inserts)).toBe(0);
    expect(keyboardAutocompleteFalsePositive([], [...inserts, input(4, 160, 1)])).toBe(0);
  });

  it("menos de dos inserciones devuelve 0", () => {
    expect(keyboardAutocompleteFalsePositive([], [input(1, 100, 0)])).toBe(0);
  });
});

describe("L98 · Enter para enviar", () => {
  it("Enter instantáneo y terminal puntúa alto, con pausa bajo", () => {
    const bot = [key(1, 0, 0), key(2, 100, 0), key(3, 110, 0, 4)];
    expect(keyboardEnterSubmit(bot)).toBeCloseTo(1, 6);
    const human = [key(1, 0, 0), key(2, 100, 0), key(3, 500, 0, 4)];
    expect(keyboardEnterSubmit(human)).toBe(0);
  });

  it("sin Enter devuelve 0", () => {
    expect(keyboardEnterSubmit(downs(Array(8).fill(0), 100))).toBe(0);
  });
});

describe("L100 · mayúsculas", () => {
  it("modificador y letra instantáneos puntúan alto, con hueco real bajo", () => {
    const bot = [
      key(1, 0, 0, 6),
      key(2, 0, 0, 0),
      key(3, 100, 0, 6),
      key(4, 100, 0, 0),
      key(5, 200, 0, 6),
      key(6, 200, 0, 0),
    ];
    expect(keyboardCapitalization(bot)).toBeCloseTo(1, 6);
    const human = bot.map((sample, i) => (i % 2 === 0 ? sample : { ...sample, t: sample.t + 40 }));
    expect(keyboardCapitalization(human)).toBe(0);
  });

  it("menos de dos pares devuelve 0", () => {
    expect(keyboardCapitalization([key(1, 0, 0, 6), key(2, 0, 0, 0), key(3, 100, 0, 0)])).toBe(0);
  });
});

describe("L101 · teclas físicas vs programáticas", () => {
  it("trusted=0 o pulsaciones casi nulas puntúan alto", () => {
    const untrusted = [
      key(1, 0, 0, 0, 0),
      key(2, 60, 1, 0, 0),
      key(3, 120, 0, 0, 0),
      key(4, 180, 1, 0, 0),
    ];
    expect(keyboardProgrammaticKeys(untrusted)).toBeCloseTo(1, 6);
    const shortHolds = [key(1, 0, 0), key(2, 0, 1), key(3, 60, 0), key(4, 60, 1)];
    expect(keyboardProgrammaticKeys(shortHolds)).toBeCloseTo(1, 6);
  });

  it("teclas físicas con pulsaciones normales devuelven 0", () => {
    const human = [key(1, 0, 0), key(2, 60, 1), key(3, 120, 0), key(4, 180, 1)];
    expect(keyboardProgrammaticKeys(human)).toBe(0);
  });

  it("sin datos devuelve 0", () => {
    expect(keyboardProgrammaticKeys([])).toBe(0);
  });
});

describe("integración · peso 0 e invarianza del score", () => {
  it("todas las medidas nuevas tienen peso 0 y están en [0,1]", () => {
    const features = extractKeyboardFeatures(downs(Array(12).fill(0), 80), []);
    for (const name of NEW_KEYS) {
      expect(KEYBOARD_FEATURE_WEIGHTS[name]).toBe(0);
      expect(features[name]).toBeGreaterThanOrEqual(0);
      expect(features[name]).toBeLessThanOrEqual(1);
    }
    const empty = extractKeyboardFeatures([], []);
    for (const name of NEW_KEYS) {
      expect(Number.isFinite(empty[name])).toBe(true);
    }
  });

  it("cambiar las medidas nuevas no altera computeKeyboardScore", () => {
    const base = extractKeyboardFeatures(downs(Array(30).fill(0), 60), []);
    const zeros = { ...base } as KeyboardFeatures;
    const ones = { ...base } as KeyboardFeatures;
    for (const name of NEW_KEYS) {
      zeros[name] = 0;
      ones[name] = 1;
    }
    expect(computeKeyboardScore(zeros)).toBe(computeKeyboardScore(ones));
  });
});
