// Red-team de los extractores: pruebas deterministas (LCG) con muestras
// hostiles. Ninguna medida debe lanzar, devolver NaN/Infinity ni salir de
// [0,1]; los hashtables de pesos deben ser inmutables en runtime.
import { describe, expect, it } from "bun:test";
import * as clickF from "../src/features/click";
import * as keyboardF from "../src/features/keyboard";
import * as mouseF from "../src/features/mouse";
import * as scrollF from "../src/features/scroll";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";
import { clamp, distance, linear, mean, median, stddev, variance } from "../src/utils/math";

// ---------------------------------------------------------------------------
// Generador determinista (LCG de Numerical Recipes) y pool hostil
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const EDGE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -0,
  1e308,
  -1e308,
  1e-12,
  -1e-12,
  1,
  -1,
  2.5,
  40,
  300,
  1000,
  1e6,
];

function hostile(rng: () => number): number {
  if (rng() < 0.5) return EDGE[Math.floor(rng() * EDGE.length)];
  const exponent = Math.floor(rng() * 320) - 160;
  return 10 ** exponent * (rng() * 2 - 1);
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

function lengthFor(rng: () => number): number {
  return pick(rng, [0, 1, 2, 3, 5, 8, 16, 40]);
}

function pointer(rng: () => number): PointerSample {
  return {
    seq: hostile(rng),
    x: hostile(rng),
    y: hostile(rng),
    t: hostile(rng),
    kind: pick(rng, [0, 0, 0, 1, 2, -1, 7, Number.NaN]) as PointerSample["kind"],
    pointerType: pick(rng, [0, 1, 2, 3, -1, 99, Number.NaN]) as PointerSample["pointerType"],
    trusted: pick(rng, [0, 1, Number.NaN, 2]) as 0 | 1,
  };
}

function clickSample(rng: () => number): ClickSample {
  return {
    seq: hostile(rng),
    x: hostile(rng),
    y: hostile(rng),
    t: hostile(rng),
    kind: pick(rng, [0, 1, 2, Number.NaN]) as 0 | 1,
    button: pick(rng, [0, 1, 2, Number.NaN, -1, 99]),
    trusted: pick(rng, [0, 1, Number.NaN]) as 0 | 1,
  };
}

function scrollSample(rng: () => number): ScrollSample {
  return {
    seq: hostile(rng),
    dx: hostile(rng),
    dy: hostile(rng),
    t: hostile(rng),
    trusted: pick(rng, [0, 1, Number.NaN]) as 0 | 1,
    source: pick(rng, [0, 1, 2, Number.NaN]) as 0 | 1,
  };
}

function keySample(rng: () => number): KeySample {
  return {
    seq: hostile(rng),
    t: hostile(rng),
    kind: pick(rng, [0, 1, 2, Number.NaN]) as 0 | 1,
    category: pick(rng, [0, 1, 2, 3, 4, 5, 6, 7, -1, 99, Number.NaN]) as KeySample["category"],
    trusted: pick(rng, [0, 1, Number.NaN]) as 0 | 1,
  };
}

function inputSample(rng: () => number): InputSample {
  return {
    seq: hostile(rng),
    t: hostile(rng),
    kind: 0,
    inputType: pick(rng, [0, 1, 2, 3, 4, 5, -1, 99, Number.NaN]) as InputSample["inputType"],
    trusted: pick(rng, [0, 1, Number.NaN]) as 0 | 1,
  };
}

function many<T>(rng: () => number, make: (rng: () => number) => T): T[] {
  return Array.from({ length: lengthFor(rng) }, () => make(rng));
}

// ---------------------------------------------------------------------------
// Invariantes
// ---------------------------------------------------------------------------

function expectScore(value: number, label: string): void {
  expect(typeof value, `${label}: tipo`).toBe("number");
  expect(Number.isNaN(value), `${label}: NaN`).toBe(false);
  expect(Number.isFinite(value), `${label}: finito`).toBe(true);
  expect(value, `${label}: >= 0`).toBeGreaterThanOrEqual(0);
  expect(value, `${label}: <= 1`).toBeLessThanOrEqual(1);
}

function expectScoreObject(obj: object, label: string): void {
  for (const [key, value] of Object.entries(obj)) {
    expectScore(value as number, `${label}.${key}`);
  }
}

function runScores<T extends unknown[]>(
  measures: ReadonlyArray<readonly [string, (...args: T) => number]>,
  args: T,
  label: string,
): void {
  for (const [name, fn] of measures) {
    let result: number;
    try {
      result = fn(...args);
    } catch (error) {
      throw new Error(`${label}.${name} lanzó: ${String(error)}`);
    }
    expectScore(result, `${label}.${name}`);
  }
}

const MOUSE_MEASURES: ReadonlyArray<readonly [string, (s: PointerSample[]) => number]> = [
  ["mouseStraightness", mouseF.mouseStraightness],
  ["mouseTeleport", mouseF.mouseTeleport],
  ["mouseSpeedUniformity", mouseF.mouseSpeedUniformity],
  ["mouseJerk", mouseF.mouseJerk],
  ["mouseTremor", mouseF.mouseTremor],
  ["mouseIntervalRegularity", mouseF.mouseIntervalRegularity],
  ["mouseOvershoot", mouseF.mouseOvershoot],
  ["mouseTurnSmoothness", mouseF.mouseTurnSmoothness],
  ["mouseMicroPauses", mouseF.mouseMicroPauses],
  ["mouseRoundSteps", mouseF.mouseRoundSteps],
  ["mouseCurvature", mouseF.mouseCurvature],
  ["mouseDirectionChanges", mouseF.mouseDirectionChanges],
  ["mouseLargeJumps", mouseF.mouseLargeJumps],
  ["mouseZigzag", mouseF.mouseZigzag],
  ["mouseEdgeEntries", mouseF.mouseEdgeEntries],
  ["mouseAverageSpeed", mouseF.mouseAverageSpeed],
  ["mouseBellProfile", mouseF.mouseBellProfile],
  ["mouseSpeedVariation", mouseF.mouseSpeedVariation],
  ["mouseImpossibleSpeed", mouseF.mouseImpossibleSpeed],
  ["mouseTemporalResolution", mouseF.mouseTemporalResolution],
  ["mouseSubpixel", mouseF.mouseSubpixel],
  ["mouseDeviceType", mouseF.mouseDeviceType],
  ["mouseFineCorrection", mouseF.mouseFineCorrection],
  ["mouseClickPrecision", mouseF.mouseClickPrecision],
  ["mouseCorrectedMisses", mouseF.mouseCorrectedMisses],
];

const CLICK_MEASURES: ReadonlyArray<readonly [string, (s: ClickSample[]) => number]> = [
  ["clickDurationRegularity", clickF.clickDurationRegularity],
  ["clickIntervalRegularity", clickF.clickIntervalRegularity],
  ["clickBurstiness", clickF.clickBurstiness],
  ["clickDownUpDrift", clickF.clickDownUpDrift],
  ["clickSingleButton", clickF.clickSingleButton],
  ["clickNoPauses", clickF.clickNoPauses],
  ["clickAimConsistency", clickF.clickAimConsistency],
  ["clickInstantaneous", clickF.clickInstantaneous],
  ["clickDoubleClickRhythm", clickF.clickDoubleClickRhythm],
  ["clickSecondaryButtons", clickF.clickSecondaryButtons],
];

const SCROLL_MEASURES: ReadonlyArray<readonly [string, (s: ScrollSample[]) => number]> = [
  ["scrollDeltaUniformity", scrollF.scrollDeltaUniformity],
  ["scrollIntervalRegularity", scrollF.scrollIntervalRegularity],
  ["scrollDirectionChanges", scrollF.scrollDirectionChanges],
  ["scrollDecelerationProfile", scrollF.scrollDecelerationProfile],
  ["scrollNoPauses", scrollF.scrollNoPauses],
  ["scrollRoundDeltas", scrollF.scrollRoundDeltas],
  ["scrollAxisLock", scrollF.scrollAxisLock],
  ["scrollLargeJumps", scrollF.scrollLargeJumps],
  ["scrollSpeed", scrollF.scrollSpeed],
  ["scrollInstantEnd", scrollF.scrollInstantEnd],
];

const KEY_MEASURES: ReadonlyArray<readonly [string, (k: KeySample[], i: InputSample[]) => number]> =
  [
    ["keyboardIntervalRegularity", keyboardF.keyboardIntervalRegularity],
    ["keyboardHoldRegularity", keyboardF.keyboardHoldRegularity],
    ["keyboardCorrectionBursts", keyboardF.keyboardCorrectionBursts],
    ["keyboardPasteRatio", keyboardF.keyboardPasteRatio],
    ["keyboardTextWithoutKeydown", keyboardF.keyboardTextWithoutKeydown],
    ["keyboardModifierShortcuts", keyboardF.keyboardModifierShortcuts],
    ["keyboardNoPauses", keyboardF.keyboardNoPauses],
    ["keyboardExactRhythm", keyboardF.keyboardExactRhythm],
    ["keyboardIntervalDistribution", keyboardF.keyboardIntervalDistribution],
    ["keyboardTypingSpeed", keyboardF.keyboardTypingSpeed],
    ["keyboardPauseAfterError", keyboardF.keyboardPauseAfterError],
    ["keyboardWordPauses", keyboardF.keyboardWordPauses],
    ["keyboardSentenceEndPauses", keyboardF.keyboardSentenceEndPauses],
    ["keyboardSelectionDeletion", keyboardF.keyboardSelectionDeletion],
    ["keyboardArrowUsage", keyboardF.keyboardArrowUsage],
    ["keyboardAutocompleteFalsePositive", keyboardF.keyboardAutocompleteFalsePositive],
    ["keyboardEnterSubmit", keyboardF.keyboardEnterSubmit],
    ["keyboardCapitalization", keyboardF.keyboardCapitalization],
    ["keyboardProgrammaticKeys", keyboardF.keyboardProgrammaticKeys],
  ];

const MEASURE_COUNT =
  MOUSE_MEASURES.length + CLICK_MEASURES.length + SCROLL_MEASURES.length + KEY_MEASURES.length;

describe("fuzz determinista LCG: invariantes de medidas y extractores", () => {
  it(`cubre ${MEASURE_COUNT} medidas por caso (400 casos por señal)`, () => {
    expect(MEASURE_COUNT).toBeGreaterThanOrEqual(60);
  });

  it("mouse: ninguna medida lanza ni devuelve NaN/Infinity/fuera de [0,1]", () => {
    const rng = lcg(0x51f15e);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const samples = many(rng, pointer);
      runScores(MOUSE_MEASURES, [samples], `mouse#${iteration}`);
      expectScoreObject(mouseF.extractMouseFeatures(samples), `extractMouseFeatures#${iteration}`);
      expectScoreObject(
        mouseF.extractPartialMouseFeatures(samples),
        `extractPartialMouseFeatures#${iteration}`,
      );
      const segments = mouseF.countSegments(samples);
      expect(Number.isFinite(segments) && segments >= 0).toBe(true);
    }
  });

  it("click: ninguna medida lanza ni devuelve NaN/Infinity/fuera de [0,1]", () => {
    const rng = lcg(0xc11c0);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const samples = many(rng, clickSample);
      runScores(CLICK_MEASURES, [samples], `click#${iteration}`);
      expectScoreObject(clickF.extractClickFeatures(samples), `extractClickFeatures#${iteration}`);
      expectScoreObject(
        clickF.extractPartialClickFeatures(samples),
        `extractPartialClickFeatures#${iteration}`,
      );
    }
  });

  it("scroll: ninguna medida lanza ni devuelve NaN/Infinity/fuera de [0,1]", () => {
    const rng = lcg(0x5c2011);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const samples = many(rng, scrollSample);
      runScores(SCROLL_MEASURES, [samples], `scroll#${iteration}`);
      expectScoreObject(
        scrollF.extractScrollFeatures(samples),
        `extractScrollFeatures#${iteration}`,
      );
      expectScoreObject(
        scrollF.extractPartialScrollFeatures(samples),
        `extractPartialScrollFeatures#${iteration}`,
      );
      expect(scrollF.withoutAutoscroll(samples).length).toBeLessThanOrEqual(samples.length);
    }
  });

  it("keyboard: ninguna medida lanza ni devuelve NaN/Infinity/fuera de [0,1]", () => {
    const rng = lcg(0x4eb0a4);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const keys = many(rng, keySample);
      const inputs = many(rng, inputSample);
      runScores(KEY_MEASURES, [keys, inputs], `keyboard#${iteration}`);
      expectScoreObject(
        keyboardF.extractKeyboardFeatures(keys, inputs),
        `extractKeyboardFeatures#${iteration}`,
      );
      const features = keyboardF.extractKeyboardFeatures(keys, inputs);
      const device = pick(rng, ["auto", "desktop", "touch", "tv"] as const);
      expectScoreObject(
        keyboardF.keyboardFeaturesForDevice(features, keys, device),
        `keyboardFeaturesForDevice#${iteration}`,
      );
      const window = keyboardF.keyboardWindowMs(keys);
      expect(Number.isFinite(window) && !Number.isNaN(window)).toBe(true);
      expect(Number.isFinite(keyboardF.countKeyDowns(keys))).toBe(true);
      expect(typeof keyboardF.hasKeyboardEvidence(keys, inputs)).toBe("boolean");
    }
  });

  it("math utils: resultados finitos con NaN/±Infinity/1e308", () => {
    const rng = lcg(0x9a7b1);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const values = many(rng, hostile);
      for (const [name, fn] of [
        ["mean", mean],
        ["variance", variance],
        ["stddev", stddev],
        ["median", median],
      ] as const) {
        const result = fn(values);
        expect(Number.isFinite(result), `${name}#${iteration}`).toBe(true);
        expect(Number.isNaN(result), `${name}#${iteration}`).toBe(false);
      }
      const a = hostile(rng);
      const b = hostile(rng);
      for (const [name, value] of [
        ["clamp", clamp(a, 0, 1)],
        ["linear", linear(a, 0, 1)],
        ["distance", distance(a, b)],
      ] as const) {
        expect(Number.isFinite(value), `${name}#${iteration}`).toBe(true);
        expect(Number.isNaN(value), `${name}#${iteration}`).toBe(false);
      }
    }
  });

  it("mismo seed produce exactamente los mismos resultados", () => {
    const collect = (): number[] => {
      const rng = lcg(0xabcdef);
      const out: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const samples = many(rng, pointer);
        out.push(mouseF.mouseStraightness(samples), mouseF.mouseTeleport(samples));
      }
      return out;
    };
    expect(collect()).toEqual(collect());
  });

  it("sin coste superlineal con 50k muestras", () => {
    const N = 50_000;
    const rng = lcg(0x1234abcd);
    const ptr: PointerSample[] = Array.from({ length: N }, (_, i) => ({
      seq: i,
      x: rng() * 1000,
      y: rng() * 1000,
      t: i * 10 + Math.floor(rng() * 3),
      kind: i % 20 === 0 ? 1 : 0,
      pointerType: 0,
      trusted: 1,
    }));
    const cls: ClickSample[] = Array.from({ length: N }, (_, i) => ({
      seq: i,
      x: rng() * 1000,
      y: rng() * 1000,
      t: i * 20,
      kind: i % 2 === 0 ? 0 : 1,
      button: 0,
      trusted: 1,
    }));
    const scr: ScrollSample[] = Array.from({ length: N }, (_, i) => ({
      seq: i,
      dx: rng() * 100 - 50,
      dy: rng() * 200 - 100,
      t: i * 10,
      trusted: 1,
      source: i % 7 === 0 ? 1 : 0,
    }));
    const keys: KeySample[] = Array.from({ length: N }, (_, i) => ({
      seq: i,
      t: i * 10,
      kind: i % 2 === 0 ? 0 : 1,
      category: (i % 8) as KeySample["category"],
      trusted: 1,
    }));
    const inputs: InputSample[] = Array.from({ length: N }, (_, i) => ({
      seq: i,
      t: i * 10 + 5,
      kind: 0,
      inputType: (i % 6) as InputSample["inputType"],
      trusted: 1,
    }));

    const started = performance.now();
    runScores(MOUSE_MEASURES, [ptr], "perf.mouse");
    runScores(CLICK_MEASURES, [cls], "perf.click");
    runScores(SCROLL_MEASURES, [scr], "perf.scroll");
    runScores(KEY_MEASURES, [keys, inputs], "perf.keyboard");
    expectScoreObject(mouseF.extractMouseFeatures(ptr), "perf.extractMouseFeatures");
    expectScoreObject(mouseF.extractPartialMouseFeatures(ptr), "perf.extractPartialMouseFeatures");
    expectScoreObject(clickF.extractClickFeatures(cls), "perf.extractClickFeatures");
    expectScoreObject(scrollF.extractScrollFeatures(scr), "perf.extractScrollFeatures");
    expectScoreObject(
      keyboardF.extractKeyboardFeatures(keys, inputs),
      "perf.extractKeyboardFeatures",
    );
    const elapsed = performance.now() - started;
    // Un pase lineal sobre ~50k muestras por medida: margen amplio para CI.
    expect(elapsed, `tiempo total ${elapsed.toFixed(0)}ms`).toBeLessThan(15_000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Regresiones explícitas: input -> síntoma -> arreglo
// ---------------------------------------------------------------------------

function pointerLine(coords: Array<[number, number, number]>): PointerSample[] {
  return coords.map(([x, y, t], i) => ({
    seq: i,
    x,
    y,
    t,
    kind: 0,
    pointerType: 0,
    trusted: 1,
  }));
}

describe("regresiones de seguridad", () => {
  it("distancia 1e308 no desborda a Infinity ni contamina medianas", () => {
    expect(Number.isFinite(distance(1e308, 1e308))).toBe(true);
    expect(distance(Number.NaN, 1)).toBe(0);
    expect(Number.isFinite(median([Number.NaN, 1e308, 1e308]))).toBe(true);
  });

  it("mean/variance/stddev de 1e308 y NaN devuelven finitos", () => {
    expect(Number.isFinite(mean([Number.NaN, 1e308, 1e308]))).toBe(true);
    expect(Number.isFinite(variance([1e308, -1e308]))).toBe(true);
    expect(Number.isFinite(stddev([1e308, -1e308]))).toBe(true);
    expectScore(linear(Number.NaN, 0, 1), "linear(NaN)");
    expectScore(clamp(Number.NaN, 0, 1), "clamp(NaN)");
  });

  it("coordenadas 1e308: straightness/tremor/speedUniformity dejaban NaN", () => {
    const samples = pointerLine([
      [0, 0, 0],
      [1e308, 0, 1],
      [1e308, 0, 2],
    ]);
    expectScore(mouseF.mouseStraightness(samples), "mouseStraightness(1e308)");
    expectScore(mouseF.mouseTremor(samples), "mouseTremor(1e308)");
    expectScore(mouseF.mouseSpeedUniformity(samples), "mouseSpeedUniformity(1e308)");
  });

  it("coordenadas NaN/Infinity: extractores de mouse dejaban NaN", () => {
    const samples = pointerLine([
      [0, 0, 0],
      [Number.NaN, 1, 1],
      [1, Number.POSITIVE_INFINITY, 2],
      [-1, -1, 3],
    ]);
    expectScoreObject(mouseF.extractMouseFeatures(samples), "extractMouseFeatures(NaN)");
    expectScoreObject(
      mouseF.extractPartialMouseFeatures(samples),
      "extractPartialMouseFeatures(NaN)",
    );
    expectScore(mouseF.mouseAverageSpeed(samples), "mouseAverageSpeed(NaN)");
    expectScore(mouseF.mouseCurvature(samples), "mouseCurvature(NaN)");
  });

  it("pointerType fuera de 0..3: deviceType salía de [0,1] o era NaN", () => {
    for (const type of [-1, 4, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const samples = pointerLine([
        [0, 0, 0],
        [1, 1, 1],
      ]).map((sample) => ({ ...sample, pointerType: type as 0 }));
      expectScore(mouseF.mouseDeviceType(samples), `mouseDeviceType(${type})`);
    }
  });

  it("saltos 1e308: overshoot y teleport no producen NaN", () => {
    const samples = pointerLine([
      [0, 0, 0],
      [1e308, 1e308, 1],
      [-1e308, -1e308, 2],
      [1e308, -1e308, 3],
    ]);
    expectScore(mouseF.mouseOvershoot(samples), "mouseOvershoot(huge)");
    expectScore(mouseF.mouseTeleport(samples), "mouseTeleport(huge)");
    expectScore(mouseF.mouseLargeJumps(samples), "mouseLargeJumps(huge)");
  });

  it("clics con NaN/1e308: deriva y puntería no desbordan", () => {
    const samples: ClickSample[] = [
      { seq: 0, x: 0, y: 0, t: 0, kind: 0, button: 0, trusted: 1 },
      { seq: 1, x: Number.NaN, y: Number.NaN, t: 1, kind: 1, button: 0, trusted: 1 },
      { seq: 2, x: 1e308, y: 1e308, t: 2, kind: 0, button: 0, trusted: 1 },
      { seq: 3, x: -1e308, y: 0, t: 3, kind: 1, button: 0, trusted: 1 },
      { seq: 4, x: 5, y: 5, t: 4, kind: 0, button: 0, trusted: 1 },
      { seq: 5, x: 6, y: 6, t: 5, kind: 1, button: 0, trusted: 1 },
    ];
    expectScoreObject(clickF.extractClickFeatures(samples), "extractClickFeatures(hostile)");
    expectScore(clickF.clickDownUpDrift(samples), "clickDownUpDrift(hostile)");
    expectScore(clickF.clickAimConsistency(samples), "clickAimConsistency(hostile)");
    expectScoreObject(
      clickF.extractPartialClickFeatures(samples),
      "extractPartialClickFeatures(hostile)",
    );
  });

  it("scroll con dx/dy infinitos: axisLock/DeltaUniformity no dan NaN", () => {
    const samples: ScrollSample[] = [
      { seq: 0, dx: Number.NaN, dy: Number.NaN, t: 0, trusted: 1, source: 0 },
      { seq: 1, dx: 1e308, dy: 1e308, t: 1, trusted: 1, source: 0 },
      { seq: 2, dx: Number.POSITIVE_INFINITY, dy: -1e308, t: 2, trusted: 1, source: 0 },
    ];
    expectScoreObject(scrollF.extractScrollFeatures(samples), "extractScrollFeatures(hostile)");
    expectScore(scrollF.scrollAxisLock(samples), "scrollAxisLock(NaN)");
    expectScore(scrollF.scrollDeltaUniformity(samples), "scrollDeltaUniformity(huge)");
    expectScoreObject(
      scrollF.extractPartialScrollFeatures(samples),
      "extractPartialScrollFeatures(hostile)",
    );
  });

  it("tiempo infinito en teclado: intervalRegularity y ventana no dan NaN/Infinity", () => {
    const keys: KeySample[] = [0, Number.POSITIVE_INFINITY, 2, 3, 4, 5].map((t, i) => ({
      seq: i,
      t,
      kind: 0,
      category: 0,
      trusted: 1,
    }));
    expectScore(keyboardF.keyboardIntervalRegularity(keys), "keyboardIntervalRegularity(Infinity)");
    expect(Number.isFinite(keyboardF.keyboardWindowMs(keys))).toBe(true);
    expectScoreObject(
      keyboardF.extractKeyboardFeatures(keys, []),
      "extractKeyboardFeatures(Infinity)",
    );
  });

  it("categorías/inputType fuera de rango y trusted NaN: extractor finito", () => {
    const keys: KeySample[] = [0, 10, 20, 30, 40, 50].map((t, i) => ({
      seq: i,
      t,
      kind: 0,
      category: (i % 2 === 0 ? 99 : Number.NaN) as 0,
      trusted: Number.NaN as 0,
    }));
    const inputs: InputSample[] = [0, 10, 20].map((t, i) => ({
      seq: i,
      t,
      kind: 0,
      inputType: (i === 0 ? -1 : 99) as 0,
      trusted: Number.NaN as 0,
    }));
    expectScoreObject(
      keyboardF.extractKeyboardFeatures(keys, inputs),
      "extractKeyboardFeatures(out-of-range)",
    );
  });

  it("timestamps duplicados, negativos e invertidos siguen siendo finitos", () => {
    const samples = pointerLine([
      [0, 0, 5],
      [1, 1, 5],
      [2, 2, 5],
      [3, 3, -10],
      [4, 4, 2],
    ]);
    expectScoreObject(mouseF.extractMouseFeatures(samples), "extractMouseFeatures(backwards t)");
    expectScoreObject(
      mouseF.extractPartialMouseFeatures(samples),
      "extractPartialMouseFeatures(backwards t)",
    );
  });

  it("evidencia vacía devuelve el neutro documentado", () => {
    expect(mouseF.mouseStraightness([])).toBe(mouseF.NEUTRAL);
    expect(clickF.clickDurationRegularity([])).toBe(clickF.CLICK_NEUTRAL);
    expect(scrollF.scrollIntervalRegularity([])).toBe(scrollF.SCROLL_NEUTRAL);
    expect(keyboardF.keyboardIntervalRegularity([])).toBe(keyboardF.KEYBOARD_NEUTRAL);
  });
});

describe("tablas de pesos inmutables en runtime", () => {
  const tables = [
    ["MOUSE_PARTIAL_FEATURE_WEIGHTS", mouseF.MOUSE_PARTIAL_FEATURE_WEIGHTS],
    ["CLICK_FEATURE_WEIGHTS", clickF.CLICK_FEATURE_WEIGHTS],
    ["CLICK_PARTIAL_FEATURE_WEIGHTS", clickF.CLICK_PARTIAL_FEATURE_WEIGHTS],
    ["SCROLL_FEATURE_WEIGHTS", scrollF.SCROLL_FEATURE_WEIGHTS],
    ["SCROLL_PARTIAL_FEATURE_WEIGHTS", scrollF.SCROLL_PARTIAL_FEATURE_WEIGHTS],
    ["KEYBOARD_FEATURE_WEIGHTS", keyboardF.KEYBOARD_FEATURE_WEIGHTS],
  ] as const;

  const expected: Record<string, Record<string, number>> = {
    MOUSE_PARTIAL_FEATURE_WEIGHTS: Object.fromEntries(
      Object.keys(mouseF.MOUSE_PARTIAL_FEATURE_WEIGHTS).map((key) => [key, 0]),
    ),
    CLICK_FEATURE_WEIGHTS: {
      durationRegularity: 0.1,
      intervalRegularity: 0.35,
      burstiness: 0.3,
      downUpDrift: 0,
      singleButton: 0,
      noPauses: 0,
      aimConsistency: 0.2,
    },
    CLICK_PARTIAL_FEATURE_WEIGHTS: {
      instantaneousClick: 0,
      doubleClickRhythm: 0,
      secondaryButtons: 0,
    },
    SCROLL_FEATURE_WEIGHTS: {
      deltaUniformity: 0.1,
      intervalRegularity: 0.45,
      directionChanges: 0.1,
      decelerationProfile: 0.2,
      noPauses: 0.1,
      roundDeltas: 0.05,
      axisLock: 0,
      largeJumps: 0.15,
    },
    SCROLL_PARTIAL_FEATURE_WEIGHTS: { scrollSpeed: 0, instantEnd: 0 },
    KEYBOARD_FEATURE_WEIGHTS: {
      intervalRegularity: 0.3,
      holdRegularity: 0.15,
      correctionBursts: 0.1,
      pasteRatio: 0.15,
      textWithoutKeydown: 0.2,
      modifierShortcuts: 0.1,
      noPauses: 0.1,
      exactRhythm: 0.15,
      intervalDistribution: 0,
      typingSpeed: 0,
      pauseAfterError: 0,
      wordPauses: 0,
      sentenceEndPauses: 0,
      selectionDeletion: 0,
      arrowUsage: 0,
      autocompleteFalsePositive: 0,
      enterSubmit: 0,
      capitalization: 0,
      programmaticKeys: 0,
    },
  };

  it("todas están congeladas y conservan sus valores", () => {
    for (const [name, table] of tables) {
      expect(Object.isFrozen(table), `${name} congelada`).toBe(true);
      expect({ ...table }, `${name} valores`).toEqual(expected[name]);
    }
  });

  it("un intento de mutación desde la página no altera los pesos", () => {
    for (const [name, table] of tables) {
      const before = { ...table };
      try {
        (table as unknown as Record<string, number>)[Object.keys(table)[0]] = 1;
      } catch {
        // Modo estricto: lanza TypeError. También es una defensa válida.
      }
      expect({ ...table }, `${name} inalterada`).toEqual(before);
    }
  });
});
