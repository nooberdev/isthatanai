// Auditoría REALISTA de todos los ítems de teclado del checklist (L70-L102),
// incluidas las medidas "final" (lane opt-in, peso 0).
//
// Reglas de privacidad: SOLO números (category/kind/t/trusted). Nunca se
// construye ni se lee una cadena de tecla, código de tecla ni texto. Las
// "palabras" de los escenarios son solo posiciones en un array de categorías.
//
// Cada ítem tiene su propio test con un escenario creíble; además se cubren
// timestamps desordenados, repetición de tecla, solapes, keyup perdido,
// sesiones enormes y valores numéricos hostiles.

import { describe, expect, it } from "bun:test";
import {
  extractFinalKeyboardFeatures,
  extractKeyboardFeatures,
  KEYBOARD_FEATURE_WEIGHTS,
  KEYBOARD_FINAL_FEATURE_WEIGHTS,
  KEYBOARD_NEUTRAL,
  keyboardArrowUsage,
  keyboardAutocompleteFalsePositive,
  keyboardCapitalization,
  keyboardCorrectionBursts,
  keyboardEnterSubmit,
  keyboardExactRhythm,
  keyboardFirstKeyPause,
  keyboardHandSwitch,
  keyboardHoldRegularity,
  keyboardIntervalDistribution,
  keyboardIntervalRegularity,
  keyboardKeyOverlap,
  keyboardLetterPairs,
  keyboardModifierShortcuts,
  keyboardNoPauses,
  keyboardPasteRatio,
  keyboardPauseAfterError,
  keyboardProgrammaticKeys,
  keyboardRepeatedKey,
  keyboardRhythmByTextLength,
  keyboardSelectionDeletion,
  keyboardSentenceEndPauses,
  keyboardTabUsage,
  keyboardTextWithoutKeydown,
  keyboardTypingSpeed,
  keyboardWarmupAcceleration,
  keyboardWordPauses,
  keyboardZeroErrorsLongText,
} from "../../src/features/keyboard";
import type { InputSample, InputTypeCode, KeyCategory, KeySample } from "../../src/types";

// Categorías numéricas (types.ts): 0 letra, 1 dígito, 2 espacio, 3 borrar,
// 4 Enter, 5 flecha, 6 modificador, 7 otra. inputType: 0 insertText, 1 pegar.
const LETTER = 0;
const DIGIT = 1;
const SPACE = 2;
const BACKSPACE = 3;
const ENTER = 4;
const MODIFIER = 6;
const OTHER = 7;
const INSERT = 0;
const PASTE = 1;

function key(
  seq: number,
  t: number,
  kind: 0 | 1,
  category: number = LETTER,
  trusted: 0 | 1 = 1,
): KeySample {
  return { seq, t, kind, category: category as KeyCategory, trusted };
}

function input(seq: number, t: number, inputType: number, trusted: 0 | 1 = 1): InputSample {
  return { seq, t, kind: 0, inputType: inputType as InputTypeCode, trusted };
}

/** pares keydown/keyup con la duración de pulsación indicada. */
function pairs(
  times: number[],
  categories: number[],
  holds: number[],
  trusted: 0 | 1 = 1,
): KeySample[] {
  const out: KeySample[] = [];
  let seq = 0;
  for (let i = 0; i < times.length; i += 1) {
    out.push(key(++seq, times[i], 0, categories[i], trusted));
    out.push(key(++seq, times[i] + holds[i], 1, categories[i], trusted));
  }
  return out;
}

/** PRNG determinista: el mismo "humano" en cada ejecución. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Toda medida debe ser un número finito dentro de [0,1]. */
function unit(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------------
// Escenarios realistas (compartidos por los tests; solo datos numéricos).
// ---------------------------------------------------------------------------

/** Humano ~45 WPM: arranque lento que "calienta", jitter, pausas de palabra,
 *  dos correcciones con backspace, pausa de pensamiento >= 1s, un pegado y
 *  tres pares Shift+letra naturales. */
function humanParagraph(): { keys: KeySample[]; inputs: InputSample[] } {
  const rand = rng(7);
  const times: number[] = [];
  const cats: number[] = [];
  const holds: number[] = [];
  let t = 1250;
  const n = 52;
  for (let i = 0; i < n; i += 1) {
    times.push(t);
    const isSpace = i > 0 && i % 6 === 5;
    cats.push(isSpace ? SPACE : LETTER);
    holds.push(58 + Math.floor(rand() * 78));
    if (i === 15 || i === 34) {
      t += 95 + Math.floor(rand() * 35);
      times.push(t);
      cats.push(BACKSPACE);
      holds.push(65 + Math.floor(rand() * 35));
      t += 360 + Math.floor(rand() * 260);
    }
    let dt = (i < 10 ? 175 : 95) + Math.floor(rand() * (i < 10 ? 95 : 75));
    if (isSpace) dt += 170 + Math.floor(rand() * 190);
    if (i === 26) dt += 1200;
    t += dt;
  }
  const keys = pairs(times, cats, holds);
  const inputs = times.map((tt, i) => input(i + 1, tt + 6, INSERT));
  inputs.push(input(1000, times[n - 3] + 20, PASTE));
  let seq = 500;
  for (let p = 0; p < 3; p += 1) {
    keys.push(key(++seq, times[2 + p * 9] - 40 - p * 8, 0, MODIFIER));
  }
  keys.sort((a, b) => a.t - b.t || a.kind - b.kind);
  return { keys, inputs };
}

/** Bot de agente: 7ms entre keydowns, pulsaciones de 3ms, eventos no fiables. */
function bot7(): { keys: KeySample[]; inputs: InputSample[] } {
  const cats = Array.from({ length: 44 }, (_, i) => (i % 6 === 5 ? SPACE : LETTER));
  const times = cats.map((_, i) => 40 + i * 7);
  return {
    keys: pairs(
      times,
      cats,
      times.map(() => 3),
      0,
    ),
    inputs: times.map((t, i) => input(i + 1, t + 1, INSERT, 0)),
  };
}

/** Agente humanizado: jitter PERIÓDICO (ciclo de 5 delays) + pausa cada 10. */
function humanized(): { keys: KeySample[]; inputs: InputSample[] } {
  const delays = [55, 62, 70, 78, 85];
  const times: number[] = [];
  let t = 90;
  for (let i = 0; i < 40; i += 1) {
    times.push(t);
    t += delays[i % delays.length] + (i % 10 === 9 ? 700 : 0);
  }
  return {
    keys: pairs(
      times,
      times.map(() => LETTER),
      times.map((_, i) => 48 + (i % 7) * 6),
    ),
    inputs: [],
  };
}

/** Gestor de contraseñas: 4 inserciones agrupadas, sin ningún keydown. */
function autofill(): { keys: KeySample[]; inputs: InputSample[] } {
  return {
    keys: [],
    inputs: [
      input(1, 1000, INSERT),
      input(2, 1008, INSERT),
      input(3, 1016, INSERT),
      input(4, 1025, INSERT),
    ],
  };
}

/** Navegación con Tab entre campos: humana (huecos irregulares) y bot. */
function tabNavigation(): { human: KeySample[]; bot: KeySample[] } {
  const cats = [
    LETTER,
    LETTER,
    OTHER,
    LETTER,
    LETTER,
    OTHER,
    LETTER,
    LETTER,
    OTHER,
    LETTER,
    LETTER,
    OTHER,
  ];
  const irregular = [300, 420, 870, 960, 1080, 1900, 1990, 2360, 2460, 3300, 3420, 4300];
  const regular = cats.map((_, i) => i * 100);
  return {
    human: pairs(
      irregular,
      cats,
      irregular.map(() => 80),
    ),
    bot: pairs(
      regular,
      cats,
      regular.map(() => 70),
    ),
  };
}

/** Enviar un formulario con Enter: terminal-instantáneo (bot) y pausado (humano). */
function enterSubmit(): { bot: KeySample[]; human: KeySample[] } {
  const cats = [LETTER, LETTER, LETTER, LETTER, LETTER, ENTER];
  const instant = [0, 120, 240, 360, 480, 485];
  const paused = [0, 120, 240, 360, 480, 980, 1080];
  return {
    bot: pairs(
      instant,
      cats,
      instant.map(() => 70),
    ),
    human: pairs(
      paused,
      [...cats, LETTER],
      paused.map(() => 70),
    ),
  };
}

/** Texto largo sin errores: 30 mutaciones, 30 letras, cero backspaces. */
function longZeroErrors(): { keys: KeySample[]; inputs: InputSample[] } {
  const times = Array.from({ length: 30 }, (_, i) => 1000 + i * 150);
  return {
    keys: pairs(
      times,
      times.map(() => LETTER),
      times.map(() => 80),
    ),
    inputs: times.map((t, i) => input(i + 1, t + 5, INSERT)),
  };
}

/** Bot con ráfagas de backspace y correcciones instantáneas. */
function rapidCorrections(): KeySample[] {
  const cats = [
    LETTER,
    LETTER,
    BACKSPACE,
    BACKSPACE,
    BACKSPACE,
    LETTER,
    BACKSPACE,
    BACKSPACE,
    BACKSPACE,
    LETTER,
  ];
  const times = cats.map((_, i) => i * 35);
  return pairs(
    times,
    cats,
    times.map(() => 25),
  );
}

const HUMAN = humanParagraph();
const BOT = bot7();
const HUMANIZED = humanized();
const AUTOFILL = autofill();
const TABS = tabNavigation();
const ENTERS = enterSubmit();
const LONG = longZeroErrors();
const RAPID = rapidCorrections();

function measured(keys: KeySample[], inputs: InputSample[] = []): number[] {
  return [
    keyboardIntervalRegularity(keys),
    keyboardHoldRegularity(keys),
    keyboardCorrectionBursts(keys),
    keyboardPasteRatio(inputs),
    keyboardTextWithoutKeydown(keys, inputs),
    keyboardModifierShortcuts(keys),
    keyboardNoPauses(keys),
    keyboardExactRhythm(keys),
    keyboardIntervalDistribution(keys),
    keyboardTypingSpeed(keys),
    keyboardPauseAfterError(keys),
    keyboardWordPauses(keys),
    keyboardSentenceEndPauses(keys),
    keyboardSelectionDeletion(keys),
    keyboardArrowUsage(keys),
    keyboardAutocompleteFalsePositive(keys, inputs),
    keyboardEnterSubmit(keys),
    keyboardCapitalization(keys),
    keyboardProgrammaticKeys(keys),
    keyboardKeyOverlap(keys),
    keyboardLetterPairs(keys),
    keyboardHandSwitch(keys),
    keyboardRepeatedKey(keys),
    keyboardWarmupAcceleration(keys),
    keyboardFirstKeyPause(keys),
    keyboardRhythmByTextLength(keys),
    keyboardZeroErrorsLongText(keys, inputs),
    keyboardTabUsage(keys),
  ];
}

// ---------------------------------------------------------------------------
// RITMO (L70-L86)
// ---------------------------------------------------------------------------

describe("checklist teclado · ritmo (L70-L86)", () => {
  it("L70 tiempo entre teclas: humano variable < bot de 7ms", () => {
    const human = keyboardIntervalRegularity(HUMAN.keys);
    const bot = keyboardIntervalRegularity(BOT.keys);
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.3);
    expect(bot).toBeGreaterThan(0.95);
  });

  it("L71 distribución del intervalo: humano de cola ancha < metrónomo", () => {
    const human = keyboardIntervalDistribution(HUMAN.keys);
    const bot = keyboardIntervalDistribution(BOT.keys);
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.3);
    expect(bot).toBeGreaterThan(0.9);
  });

  it("L72 metrónomo: bot 7ms y agente con jitter periódico puntúan alto, humano no", () => {
    const bot = keyboardExactRhythm(BOT.keys);
    const agent = keyboardExactRhythm(HUMANIZED.keys);
    const human = keyboardExactRhythm(HUMAN.keys);
    for (const value of [bot, agent, human]) unit(value);
    expect(bot).toBeGreaterThan(0.95);
    expect(agent).toBeGreaterThan(0.9); // jitter periódico = ciclo corto
    expect(human).toBeLessThan(0.1);
  });

  it("L73 tiempo de pulsación: bot constante alto, humano variable bajo, CDP <20ms neutro", () => {
    const fixed = pairs(
      Array.from({ length: 20 }, (_, i) => i * 90),
      Array(20).fill(LETTER),
      Array(20).fill(85),
    );
    const human = keyboardHoldRegularity(HUMAN.keys);
    const bot = keyboardHoldRegularity(fixed);
    const cdp = keyboardHoldRegularity(BOT.keys); // pulsaciones de 3ms
    for (const value of [human, bot, cdp]) unit(value);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBeLessThan(0.6);
    expect(cdp).toBe(0); // artefacto de automatización, no evidencia de bot
  });

  it("L74 solapamiento: humano solapa teclas, bot secuencial puntúa alto", () => {
    const human = keyboardKeyOverlap(HUMAN.keys);
    const bot = keyboardKeyOverlap(BOT.keys);
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.4);
    expect(bot).toBeGreaterThan(0.9);
  });

  it("L75 pares de letras: bot mantiene el mismo intervalo por par, humano no", () => {
    const bot = keyboardLetterPairs(BOT.keys);
    const human = keyboardLetterPairs(HUMAN.keys);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.9);
    expect(human).toBeLessThan(0.2);
  });

  it("L76 cambio de mano: bot sin ventaja puntúa alto, humano con pausas no (FIX)", () => {
    const noAdvantage = pairs(
      [0, 80, 200, 280, 400, 480, 600, 680],
      [LETTER, LETTER, DIGIT, DIGIT, LETTER, LETTER, DIGIT, DIGIT],
      Array(8).fill(60),
    );
    const human = keyboardHandSwitch(HUMAN.keys);
    const bot = keyboardHandSwitch(noAdvantage);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.95);
    // Antes del FIX el párrafo humano puntuaba 1.0 por sus pausas cognitivas.
    expect(human).toBeLessThan(0.2);
  });

  it("L77 misma tecla repetida: humano no puntúa, repetición de categoría sí (FIX)", () => {
    const repeatBot = pairs(
      Array.from({ length: 8 }, (_, i) => i * 60),
      Array(8).fill(LETTER),
      Array(8).fill(50),
    );
    const human = keyboardRepeatedKey(HUMAN.keys);
    const bot = keyboardRepeatedKey(repeatBot);
    unit(human);
    unit(bot);
    expect(bot).toBe(1);
    // Antes del FIX, escribir letras normales daba ~0.83 (falso positivo).
    expect(human).toBeLessThan(0.2);
  });

  it("L78 velocidad promedio: 45 WPMhumano ~0, bot de 7ms ~1", () => {
    const human = keyboardTypingSpeed(HUMAN.keys);
    const bot = keyboardTypingSpeed(BOT.keys);
    unit(human);
    unit(bot);
    expect(human).toBe(0);
    expect(bot).toBeGreaterThan(0.95);
  });

  it("L79 velocidad imposible: >14 teclas/s saturates a 1", () => {
    const downTimes = Array.from({ length: 10 }, (_, i) => i * 6);
    const impossible = pairs(
      downTimes,
      downTimes.map(() => LETTER),
      downTimes.map(() => 3),
    );
    const value = keyboardTypingSpeed(impossible);
    unit(value);
    expect(value).toBe(1);
  });

  it("L80 aceleración al calentar: humano arranca lento y acelera (FIX)", () => {
    const fixed = pairs(
      Array.from({ length: 12 }, (_, i) => i * 100),
      Array(12).fill(LETTER),
      Array(12).fill(70),
    );
    const human = keyboardWarmupAcceleration(HUMAN.keys);
    const bot = keyboardWarmupAcceleration(fixed);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.95);
    // Antes del FIX la pausa de pensamiento final daba 1.0 al humano.
    expect(human).toBeLessThan(bot - 0.25);
  });

  it("L81 ráfagas y pausas: humano con pausa >=1s da 0, bot continuo da 1", () => {
    const human = keyboardNoPauses(HUMAN.keys);
    const bot = keyboardNoPauses(BOT.keys);
    unit(human);
    unit(bot);
    expect(human).toBe(0);
    expect(bot).toBeGreaterThan(0.95);
  });

  it("L82 pausa antes de la primera tecla: bot arranca al cargar, humano tarda", () => {
    const human = keyboardFirstKeyPause(HUMAN.keys);
    const bot = keyboardFirstKeyPause(BOT.keys);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.9);
    expect(human).toBeLessThan(0.4);
  });

  it("L83 pausa después de un error: humano se detiene, bot corrige al instante", () => {
    const instant = [key(1, 1000, 0, LETTER), key(2, 1100, 0, BACKSPACE), key(3, 1110, 0, LETTER)];
    const paused = [key(1, 1000, 0, LETTER), key(2, 1100, 0, BACKSPACE), key(3, 1500, 0, LETTER)];
    const bot = keyboardPauseAfterError(instant);
    const human = keyboardPauseAfterError(paused);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBe(0);
  });

  it("L84 pausas entre palabras: humano marca el espacio, bot no", () => {
    const botTimes = [0, 100, 200, 210, 310, 410, 420, 520];
    const botCats = [LETTER, LETTER, SPACE, LETTER, LETTER, SPACE, LETTER, LETTER];
    const bot = keyboardWordPauses(botTimes.map((t, i) => key(i + 1, t, 0, botCats[i])));
    const humanTimes = [0, 100, 200, 450, 550, 650, 900, 1000];
    const human = keyboardWordPauses(humanTimes.map((t, i) => key(i + 1, t, 0, botCats[i])));
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBe(0);
  });

  it("L85 pausas al final de frase: bot encadena Enter, humano piensa antes", () => {
    const bot = keyboardSentenceEndPauses(ENTERS.bot);
    const human = keyboardSentenceEndPauses(ENTERS.human);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBe(0);
  });

  it("L86 ritmo según cantidad de texto: bot fijo alto, humano que cambia ritmo bajo (FIX)", () => {
    const fixed = pairs(
      Array.from({ length: 10 }, (_, i) => i * 100),
      Array(10).fill(LETTER),
      Array(10).fill(70),
    );
    const bot = keyboardRhythmByTextLength(fixed);
    const human = keyboardRhythmByTextLength(HUMAN.keys);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.95);
    // Antes del FIX las pausas dispersadas daban ~0.92 al humano.
    expect(human).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// COMPORTAMIENTO (L88-L102)
// ---------------------------------------------------------------------------

describe("checklist teclado · comportamiento (L88-L102)", () => {
  it("L88 uso de backspace: humano aislado 0, bot en ráfaga 1", () => {
    const human = keyboardCorrectionBursts(HUMAN.keys);
    const bot = keyboardCorrectionBursts(RAPID);
    unit(human);
    unit(bot);
    expect(human).toBe(0);
    expect(bot).toBeGreaterThan(0.95);
  });

  it("L89 errores y correcciones: ráfaga de borrados rápidos delata al bot", () => {
    const value = keyboardCorrectionBursts(RAPID);
    const pause = keyboardPauseAfterError(RAPID);
    unit(value);
    unit(pause);
    expect(value).toBeGreaterThan(0.9);
    expect(pause).toBeGreaterThan(0.9);
  });

  it("L90 cero errores en texto largo: bot 1, humano con corrección 0", () => {
    const bot = keyboardZeroErrorsLongText(LONG.keys, LONG.inputs);
    const withError = keyboardZeroErrorsLongText(
      [...LONG.keys, key(500, 1600, 0, BACKSPACE)],
      LONG.inputs,
    );
    unit(bot);
    unit(withError);
    expect(bot).toBe(1);
    expect(withError).toBe(0);
  });

  it("L91 selección y borrado: humano corrige sin seleccionar y no puntúa (FIX)", () => {
    const human = keyboardSelectionDeletion(HUMAN.keys);
    const bot = keyboardSelectionDeletion(RAPID);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.95);
    // Antes del FIX, cualquier backspace sin Shift+Flecha daba 1.0.
    expect(human).toBe(0);
  });

  it("L92 uso de flechas: edición anecdótica no puntúa, bot que solo borra sí (FIX)", () => {
    const human = keyboardArrowUsage(HUMAN.keys);
    const editBot = keyboardArrowUsage(RAPID);
    unit(human);
    unit(editBot);
    expect(editBot).toBeGreaterThan(0.95);
    // Antes del FIX, dos backspaces en 50 teclas daban 1.0.
    expect(human).toBe(0);
  });

  it("L93 atajos de teclado: Ctrl+C/V humanos escasos vs bot repetitivo", () => {
    const shortcutBot: KeySample[] = [];
    let seq = 0;
    let t = 0;
    for (let i = 0; i < 8; i += 1) {
      shortcutBot.push(key(++seq, t, 0, MODIFIER));
      shortcutBot.push(key(++seq, t + 100, 0, LETTER));
      shortcutBot.push(key(++seq, t + 140, 1, LETTER));
      shortcutBot.push(key(++seq, t + 150, 1, MODIFIER));
      t += 1000; // pausa humana entre copiar y pegar
    }
    const bot = keyboardModifierShortcuts(shortcutBot);
    const human = keyboardModifierShortcuts(HUMAN.keys);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.9);
    expect(human).toBeLessThan(0.2);
  });

  it("L94 pegar texto de golpe: humano con un pegado ~0, bot que solo pega 1", () => {
    const human = keyboardPasteRatio(HUMAN.inputs);
    const pasteBotInputs = Array.from({ length: 8 }, (_, i) => input(i + 1, i * 50, PASTE));
    const bot = keyboardPasteRatio(pasteBotInputs);
    unit(human);
    unit(bot);
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L95 texto sin teclas: cada inserción humana tiene keydown, fill() no", () => {
    const human = keyboardTextWithoutKeydown(HUMAN.keys, HUMAN.inputs);
    const fill = Array.from({ length: 6 }, (_, i) => input(i + 1, 100 + i * 50, INSERT));
    const bot = keyboardTextWithoutKeydown([], fill);
    unit(human);
    unit(bot);
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L96 autocompletado de contraseña: dirección INVERSA, 1 = NO bot", () => {
    const autocomplete = keyboardAutocompleteFalsePositive(AUTOFILL.keys, AUTOFILL.inputs);
    const typed = keyboardAutocompleteFalsePositive(HUMAN.keys, HUMAN.inputs);
    const pasted = keyboardAutocompleteFalsePositive(
      [],
      [input(1, 100, INSERT), input(2, 110, PASTE)],
    );
    for (const value of [autocomplete, typed, pasted]) unit(value);
    expect(autocomplete).toBe(1); // gestor de contraseñas, NO acusar de bot
    expect(typed).toBe(0);
    expect(pasted).toBe(0);
  });

  it("L97 Tab para cambiar de campo: humano irregular 0, bot regular 1", () => {
    const human = keyboardTabUsage(TABS.human);
    const bot = keyboardTabUsage(TABS.bot);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBeLessThan(0.1);
  });

  it("L98 Enter para enviar: bot instantáneo y terminal 1, humano pausado 0", () => {
    const bot = keyboardEnterSubmit(ENTERS.bot);
    const human = keyboardEnterSubmit(ENTERS.human);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBe(0);
  });

  it("L99 modificadores de forma natural: humano pocos vs bot que abusa", () => {
    const manyMods: KeySample[] = [];
    let seq = 0;
    let t = 0;
    for (let i = 0; i < 8; i += 1) {
      manyMods.push(key(++seq, t, 0, MODIFIER));
      manyMods.push(key(++seq, t + 5, 0, LETTER));
      manyMods.push(key(++seq, t + 40, 1, LETTER));
      manyMods.push(key(++seq, t + 45, 1, MODIFIER));
      t += 100;
    }
    const bot = keyboardModifierShortcuts(manyMods);
    const human = keyboardModifierShortcuts(HUMAN.keys);
    unit(bot);
    unit(human);
    expect(bot).toBeGreaterThan(0.9);
    expect(human).toBeLessThan(0.2);
  });

  it("L100 mayúsculas: Shift natural (25-70ms) 0, eventos sintáneos 1", () => {
    const natural: KeySample[] = [];
    const synthetic: KeySample[] = [];
    let seq = 0;
    for (let i = 0; i < 4; i += 1) {
      const t = 100 + i * 200;
      natural.push(key(++seq, t, 0, MODIFIER), key(++seq, t + 30 + i * 10, 0, LETTER));
      synthetic.push(key(++seq, t, 0, MODIFIER), key(++seq, t, 0, LETTER));
    }
    const human = keyboardCapitalization(natural);
    const bot = keyboardCapitalization(synthetic);
    unit(human);
    unit(bot);
    expect(bot).toBeGreaterThan(0.95);
    expect(human).toBe(0);
  });

  it("L101 teclas físicas vs programáticas: trusted=1 y holds normales 0, bot 1", () => {
    const physical = pairs([0, 100, 200, 300], Array(4).fill(LETTER), [70, 80, 75, 90]);
    const bot = keyboardProgrammaticKeys(BOT.keys);
    const human = keyboardProgrammaticKeys([...physical, ...HUMAN.keys]);
    unit(bot);
    unit(human);
    expect(bot).toBe(1);
    expect(human).toBeLessThan(0.2);
  });

  it("L102 coherencia tecleado/aparecido (sin guardar letras): humano 0, inyección 1", () => {
    // Proxy numérico: toda inserción humana tiene un keydown en los 400ms
    // previos; el texto inyectado aparece sin ninguna tecla.
    const human = keyboardTextWithoutKeydown(HUMAN.keys, HUMAN.inputs);
    const injected = keyboardTextWithoutKeydown([], LONG.inputs);
    unit(human);
    unit(injected);
    expect(human).toBe(0);
    expect(injected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CASOS LÍMITE
// ---------------------------------------------------------------------------

describe("checklist teclado · casos límite", () => {
  it("timestamps desordenados: todas las medidas finitas en [0,1]", () => {
    const keys = [
      key(1, 500, 0, LETTER),
      key(2, 100, 0, BACKSPACE),
      key(3, 300, 1, LETTER),
      key(4, 50, 0, MODIFIER),
    ];
    const inputs = [input(1, 900, INSERT), input(2, 80, PASTE)];
    for (const value of measured(keys, inputs)) unit(value);
  });

  it("repetición de tecla, solape y keyup perdido: finito, sin excepciones", () => {
    const keys = [
      key(1, 0, 0, LETTER), // keydown
      key(2, 10, 0, LETTER), // repetición (mismo dedo) solapada
      key(3, 20, 0, BACKSPACE),
      key(4, 30, 1, LETTER), // keyup del primer down
      key(5, 40, 0, LETTER),
      // el keyup del último down nunca llega
    ];
    for (const value of measured(keys)) unit(value);
    unit(keyboardKeyOverlap(keys));
  });

  it("sesión enorme (20k eventos): finito y O(n log n), sin tiempo excesivo", () => {
    const keys: KeySample[] = [];
    const inputs: InputSample[] = [];
    for (let i = 0; i < 10000; i += 1) {
      const t = i * 60 + (i % 7) * 3;
      keys.push(key(2 * i + 1, t, 0, i % 9 === 0 ? BACKSPACE : LETTER));
      keys.push(key(2 * i + 2, t + 45, 1, i % 9 === 0 ? BACKSPACE : LETTER));
      inputs.push(input(i + 1, t + 5, INSERT));
    }
    const started = Date.now();
    for (const value of measured(keys, inputs)) unit(value);
    unit(keyboardZeroErrorsLongText(keys, inputs));
    unit(keyboardAutocompleteFalsePositive(keys, inputs));
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("valores hostiles (NaN, ±Infinity, 1e308) nunca rompen una medida", () => {
    const keys = [
      key(1, Number.NaN, 0, LETTER, 0),
      key(2, Number.POSITIVE_INFINITY, 0, 999 as unknown as KeyCategory, 1),
      key(3, Number.NEGATIVE_INFINITY, 1, LETTER, 1),
      key(4, 1e308, 0, MODIFIER, 0),
      key(5, -1e308, 1, BACKSPACE, 1),
    ];
    const inputs = [
      input(1, Number.NaN, 999 as unknown as InputTypeCode, 1),
      input(2, Number.POSITIVE_INFINITY, INSERT, 0),
      input(3, 1e308, PASTE, 1),
    ];
    for (const value of measured(keys, inputs)) unit(value);
    for (const value of Object.values(extractKeyboardFeatures(keys, inputs))) unit(value);
    for (const value of Object.values(extractFinalKeyboardFeatures(keys, inputs))) unit(value);
  });

  it("privacidad: las muestras solo contienen números, nunca identidad de tecla", () => {
    const allSamples: Array<KeySample | InputSample> = [...HUMAN.keys, ...HUMAN.inputs];
    for (const sample of allSamples) {
      for (const value of Object.values(sample)) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("medidas nuevas: peso 0, neutro con muestra vacía y acotadas en [0,1]", () => {
    const partial = extractKeyboardFeatures(HUMAN.keys, HUMAN.inputs);
    const final = extractFinalKeyboardFeatures(HUMAN.keys, HUMAN.inputs);
    const zeroWeightPartial = [
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
    for (const name of zeroWeightPartial) {
      expect(KEYBOARD_FEATURE_WEIGHTS[name]).toBe(0);
      unit(partial[name]);
    }
    for (const name of Object.keys(KEYBOARD_FINAL_FEATURE_WEIGHTS) as Array<
      keyof typeof KEYBOARD_FINAL_FEATURE_WEIGHTS
    >) {
      expect(KEYBOARD_FINAL_FEATURE_WEIGHTS[name]).toBe(0);
      unit(final[name]);
    }
    for (const value of Object.values(extractFinalKeyboardFeatures([], []))) {
      expect(value).toBe(KEYBOARD_NEUTRAL);
    }
  });
});
