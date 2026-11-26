// Pruebas deterministas de la lane FINAL de medidas (L10..L111).
// Cubre los 35 ítems nuevos de mouse, click, teclado y scroll: un caso
// discriminante (IA vs humano), el caso vacío, tablas con peso 0, invarianza
// del score y defenses ante muestras hostiles (NaN/Infinity).
// Ninguna prueba toca comportamiento calibrado existente.

import { describe, expect, it } from "bun:test";
import {
  CLICK_FINAL_PARTIAL_FEATURE_WEIGHTS,
  CLICK_PARTIAL_FEATURE_WEIGHTS,
  clickNaturalDrag,
  clickNonInteractive,
  clickNoPriorMovement,
  clickOrder,
  clickTextSelection,
  extractFinalClickFeatures,
  extractPartialClickFeatures,
} from "../src/features/click";
import {
  computeKeyboardScore,
  extractFinalKeyboardFeatures,
  extractKeyboardFeatures,
  KEYBOARD_FINAL_FEATURE_WEIGHTS,
  KEYBOARD_NEUTRAL,
  type KeyboardFeatures,
  keyboardFirstKeyPause,
  keyboardHandSwitch,
  keyboardKeyOverlap,
  keyboardLetterPairs,
  keyboardRepeatedKey,
  keyboardRhythmByTextLength,
  keyboardTabUsage,
  keyboardWarmupAcceleration,
  keyboardZeroErrorsLongText,
} from "../src/features/keyboard";
import {
  extractFinalMouseFeatures,
  extractPartialMouseFeatures,
  MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS,
  MOUSE_PARTIAL_FEATURE_WEIGHTS,
  mouseAimTime,
  mouseAnticipation,
  mouseDriftAfterRelease,
  mouseFavoriteDirections,
  mouseFinalBraking,
  mouseFittsLaw,
  mouseHoverBeforeClick,
  mouseHoverIrrelevant,
  mouseInitialAcceleration,
  mouseMaxSpeed,
  mouseMovementOrigin,
  mousePerfectCurves,
  mouseRestStability,
  mouseRouteToTarget,
  mouseSpeedByDistance,
  mouseStillBeforeMove,
  mouseSymmetry,
  mouseThinkingDrift,
  mouseTimeToClick,
  NEUTRAL,
} from "../src/features/mouse";
import {
  extractFinalScrollFeatures,
  extractPartialScrollFeatures,
  SCROLL_FINAL_PARTIAL_FEATURE_WEIGHTS,
  SCROLL_PARTIAL_FEATURE_WEIGHTS,
  scrollNoOtherMovement,
  scrollProportional,
} from "../src/features/scroll";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";

// ---------------------------------------------------------------------------
// Constructores deterministas
// ---------------------------------------------------------------------------

interface RawPoint {
  x: number;
  y: number;
  t: number;
  kind?: 0 | 1 | 2;
}

function points(raw: RawPoint[]): PointerSample[] {
  return raw.map((point, index) => ({
    seq: index + 1,
    x: point.x,
    y: point.y,
    t: point.t,
    kind: point.kind ?? 0,
    pointerType: 0,
    trusted: 1,
  }));
}

function line(dx: number, dy: number, count: number, dt = 10): PointerSample[] {
  return points(
    Array.from({ length: count }, (_, index) => ({ x: index * dx, y: index * dy, t: index * dt })),
  );
}

interface AimSpec {
  distance: number;
  timeMs: number;
  gapMs?: number;
}

/** Un trayecto recto hacia un click, seguido de una frontera dura kind 2. */
function aimScenario(specs: AimSpec[]): { pointer: PointerSample[]; clicks: ClickSample[] } {
  const pointer: PointerSample[] = [];
  const clicks: ClickSample[] = [];
  let base = 0;
  let seq = 1;
  for (const spec of specs) {
    const gap = spec.gapMs ?? 0;
    pointer.push({ seq: seq++, x: 0, y: 0, t: base, kind: 0, pointerType: 0, trusted: 1 });
    pointer.push({
      seq: seq++,
      x: spec.distance,
      y: 0,
      t: base + spec.timeMs,
      kind: 0,
      pointerType: 0,
      trusted: 1,
    });
    clicks.push({
      seq: seq++,
      x: spec.distance,
      y: 0,
      t: base + spec.timeMs + gap,
      kind: 0,
      button: 0,
      trusted: 1,
    });
    pointer.push({
      seq: seq++,
      x: spec.distance,
      y: 0,
      t: base + spec.timeMs + gap + 1,
      kind: 2,
      pointerType: 0,
      trusted: 1,
    });
    base += spec.timeMs + gap + 1000;
  }
  return { pointer, clicks };
}

interface ClickSpec {
  x: number;
  y: number;
  downT: number;
  upT: number;
}

function clickPairs(specs: ClickSpec[]): ClickSample[] {
  const out: ClickSample[] = [];
  let seq = 1;
  for (const spec of specs) {
    out.push({
      seq: seq++,
      x: spec.x,
      y: spec.y,
      t: spec.downT,
      kind: 0,
      button: 0,
      trusted: 1,
    });
    out.push({
      seq: seq++,
      x: spec.x,
      y: spec.y,
      t: spec.upT,
      kind: 1,
      button: 0,
      trusted: 1,
    });
  }
  return out;
}

function scrolls(dx: number[], dy: number[], t: number[]): ScrollSample[] {
  return dx.map((value, index) => ({
    seq: index + 1,
    dx: value,
    dy: dy[index],
    t: t[index],
    trusted: 1,
    source: 0,
  }));
}

function key(seq: number, t: number, kind: 0 | 1, category: KeySample["category"] = 0): KeySample {
  return { seq, t, kind, category, trusted: 1 };
}

function downs(categories: number[], step: number, start = 0): KeySample[] {
  return categories.map((category, index) =>
    key(index + 1, start + index * step, 0, category as KeySample["category"]),
  );
}

function inputs(count: number, step = 50): InputSample[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    t: index * step,
    kind: 0 as const,
    inputType: 0 as const,
    trusted: 1 as const,
  }));
}

const FOUR_AIMS: AimSpec[] = [
  { distance: 10, timeMs: 100 },
  { distance: 100, timeMs: 100 },
  { distance: 1000, timeMs: 100 },
  { distance: 10000, timeMs: 100 },
];

// ---------------------------------------------------------------------------
// MOUSE (19 medidas)
// ---------------------------------------------------------------------------

describe("lane final · MOUSE trayectoria", () => {
  it("L10 simetría: ida y vuelta calcadas -> 1, recta -> 0, vacío -> neutro", () => {
    const out = points([
      ...Array.from({ length: 5 }, (_, i) => ({ x: i * 10, y: 0, t: i * 10 })),
      ...Array.from({ length: 5 }, (_, i) => ({ x: (10 - i) * 10, y: 0, t: (5 + i) * 10 })),
    ]);
    expect(mouseSymmetry(out)).toBe(1);
    expect(mouseSymmetry(line(10, 0, 10))).toBe(0);
    expect(mouseSymmetry([])).toBe(NEUTRAL);
  });

  it("L12 curvas perfectas: arco de giro constante -> alto, curva irregular -> bajo", () => {
    const arc = points(
      Array.from({ length: 8 }, (_, index) => {
        const angle = index * 0.2;
        return { x: 100 * Math.cos(angle), y: 100 * Math.sin(angle), t: index * 10 };
      }),
    );
    expect(mousePerfectCurves(arc)).toBeGreaterThan(0.95);
    const angles = [0, 0.1, 0.5, 0.6, 1.0, 1.1, 1.5, 1.6];
    const radii = [100, 60, 100, 60, 100, 60, 100, 60];
    const jitter = points(
      angles.map((angle, index) => ({
        x: radii[index] * Math.cos(angle),
        y: radii[index] * Math.sin(angle),
        t: index * 10,
      })),
    );
    expect(mousePerfectCurves(jitter)).toBeLessThan(0.3);
    expect(mousePerfectCurves(line(10, 0, 8))).toBe(0);
    expect(mousePerfectCurves([])).toBe(NEUTRAL);
  });

  it("L13 direcciones favoritas: ejes canónicos -> 1, ángulo arbitrario -> 0", () => {
    expect(mouseFavoriteDirections(line(10, 0, 6))).toBe(1);
    const arbitrary = points(
      Array.from({ length: 6 }, (_, index) => ({
        x: index * 10,
        y: index * 10 * Math.tan(0.3),
        t: index * 10,
      })),
    );
    expect(mouseFavoriteDirections(arbitrary)).toBe(0);
    expect(mouseFavoriteDirections([])).toBe(NEUTRAL);
  });

  it("L14 origen del movimiento: reaparición lejana -> 1, continuidad -> 0", () => {
    const abrupt = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 10, y: 0, t: 20, kind: 2 },
      { x: 1010, y: 0, t: 30 },
      { x: 1020, y: 0, t: 40 },
    ]);
    expect(mouseMovementOrigin(abrupt)).toBe(1);
    const gentle = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 10, y: 0, t: 20, kind: 2 },
      { x: 10, y: 0, t: 30 },
      { x: 20, y: 0, t: 40 },
    ]);
    expect(mouseMovementOrigin(gentle)).toBe(0);
    expect(mouseMovementOrigin([])).toBe(NEUTRAL);
  });

  it("L16 deriva al pensar: micro-vagabundeo -> alto, trayecto directo -> 0", () => {
    const coords: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [10, 0.5],
      [10, 1],
      [1, 1],
      [1, 1.5],
      [10, 1.5],
      [10, 2],
      [0, 2],
      [0, 0],
    ];
    const drift = points(coords.map(([x, y], index) => ({ x, y, t: index * 10 })));
    expect(mouseThinkingDrift(drift)).toBeGreaterThan(0.5);
    expect(mouseThinkingDrift(line(10, 0, 8))).toBe(0);
    expect(mouseThinkingDrift([])).toBe(NEUTRAL);
  });
});

describe("lane final · MOUSE velocidad y reposo", () => {
  it("L19 velocidad máxima: pico imposible -> 1, lenta -> 0", () => {
    expect(mouseMaxSpeed(line(100, 0, 2))).toBe(1);
    expect(mouseMaxSpeed(line(1, 0, 4))).toBe(0);
    expect(mouseMaxSpeed([])).toBe(NEUTRAL);
  });

  it("L21 aceleración inicial: arranque instantáneo -> 1, arranque suave -> 0", () => {
    const burst = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 110, y: 0, t: 20 },
      { x: 120, y: 0, t: 30 },
    ]);
    expect(mouseInitialAcceleration(burst)).toBe(1);
    expect(mouseInitialAcceleration(line(10, 0, 5))).toBe(0);
    expect(mouseInitialAcceleration([])).toBe(NEUTRAL);
  });

  it("L22 frenado final: ritmo constante -> 1, frena al llegar -> 0", () => {
    expect(mouseFinalBraking(line(10, 0, 6))).toBe(1);
    const braking = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 30, y: 0, t: 30 },
      { x: 30.5, y: 0, t: 40 },
    ]);
    expect(mouseFinalBraking(braking)).toBe(0);
    expect(mouseFinalBraking([])).toBe(NEUTRAL);
  });

  it("L26 velocidad según distancia: velocidad fija -> 1, crece con distancia -> 0", () => {
    const fixed = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 10, y: 0, t: 11, kind: 2 },
      { x: 10, y: 0, t: 11 },
      { x: 110, y: 0, t: 111 },
      { x: 110, y: 0, t: 112, kind: 2 },
      { x: 110, y: 0, t: 112 },
      { x: 1110, y: 0, t: 1112 },
    ]);
    expect(mouseSpeedByDistance(fixed)).toBe(1);
    const growing = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 100 },
      { x: 10, y: 0, t: 101, kind: 2 },
      { x: 10, y: 0, t: 101 },
      { x: 110, y: 0, t: 201 },
      { x: 110, y: 0, t: 202, kind: 2 },
      { x: 110, y: 0, t: 202 },
      { x: 1110, y: 0, t: 302 },
    ]);
    expect(mouseSpeedByDistance(growing)).toBe(0);
    expect(mouseSpeedByDistance([])).toBe(NEUTRAL);
  });

  it("L29 tiempo parado antes de moverse: espera inicial larga -> 1, ritmo parejo -> 0", () => {
    const waited = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 1000 },
      { x: 20, y: 0, t: 1010 },
      { x: 30, y: 0, t: 1020 },
    ]);
    expect(mouseStillBeforeMove(waited)).toBe(1);
    expect(mouseStillBeforeMove(line(10, 0, 5))).toBe(0);
    expect(mouseStillBeforeMove([])).toBe(NEUTRAL);
  });

  it("L38 estabilidad en reposo: inmovilidad total -> 1, movimiento -> 0", () => {
    const frozen = points([
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: 10 },
      { x: 0, y: 0, t: 20 },
      { x: 0, y: 0, t: 30 },
    ]);
    expect(mouseRestStability(frozen)).toBe(1);
    expect(mouseRestStability(line(10, 0, 5))).toBe(0);
    expect(mouseRestStability([])).toBe(NEUTRAL);
  });

  it("L39 deriva al soltar: salto seco tras reposo -> 1, micro-deriva -> 0", () => {
    const dry = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 100, y: 0, t: 20 },
      { x: 100, y: 0, t: 30 },
      { x: 100.1, y: 0, t: 40 },
      { x: 100.2, y: 0, t: 50 },
    ]);
    expect(mouseDriftAfterRelease(dry)).toBe(1);
    const human = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 100, y: 0, t: 20 },
      { x: 100, y: 0, t: 30 },
      { x: 180, y: 0, t: 40 },
      { x: 270, y: 0, t: 50 },
    ]);
    expect(mouseDriftAfterRelease(human)).toBe(0);
    expect(mouseDriftAfterRelease([])).toBe(NEUTRAL);
  });
});

describe("lane final · MOUSE puntería (contexto de clicks opcional)", () => {
  it("L41 ley de Fitts: tiempo fijo -> 1, crece con distancia -> 0", () => {
    const { pointer: fixed, clicks: fixedClicks } = aimScenario(FOUR_AIMS);
    expect(mouseFittsLaw(fixed, fixedClicks)).toBe(1);
    const growing = FOUR_AIMS.map((aim, index) => ({ ...aim, timeMs: 20 + index * 40 }));
    const scenario = aimScenario(growing);
    expect(mouseFittsLaw(scenario.pointer, scenario.clicks)).toBe(0);
    expect(mouseFittsLaw([])).toBe(NEUTRAL);
    expect(mouseFittsLaw(fixed)).toBe(NEUTRAL);
  });

  it("L44 tiempo de apuntar: tiempo idéntico -> 1, variable -> 0", () => {
    const scenario = aimScenario(FOUR_AIMS);
    expect(mouseAimTime(scenario.pointer, scenario.clicks)).toBe(1);
    const varied = aimScenario(
      FOUR_AIMS.map((aim, index) => ({ ...aim, timeMs: 20 + index * 90 })),
    );
    expect(mouseAimTime(varied.pointer, varied.clicks)).toBe(0);
    expect(mouseAimTime([])).toBe(NEUTRAL);
  });

  it("L45 tiempo hasta el click: click instantáneo -> 1, pausa -> 0", () => {
    const instant = aimScenario(FOUR_AIMS.map((aim) => ({ ...aim, gapMs: 0 })));
    expect(mouseTimeToClick(instant.pointer, instant.clicks)).toBe(1);
    const paused = aimScenario(FOUR_AIMS.map((aim) => ({ ...aim, gapMs: 300 })));
    expect(mouseTimeToClick(paused.pointer, paused.clicks)).toBe(0);
    expect(mouseTimeToClick([])).toBe(NEUTRAL);
  });

  it("L49 ruta hacia el objetivo: recto -> 1, meandroso -> 0", () => {
    const straight = aimScenario(FOUR_AIMS);
    expect(mouseRouteToTarget(straight.pointer, straight.clicks)).toBe(1);
    const meander = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 100, y: 100, t: 20 },
      { x: 0, y: 100, t: 30 },
      { x: 0, y: 0, t: 40 },
      { x: 0, y: 0, t: 41, kind: 2 },
      { x: 0, y: 0, t: 42 },
      { x: 100, y: 0, t: 52 },
      { x: 100, y: 100, t: 62 },
      { x: 0, y: 100, t: 72 },
      { x: 0, y: 0, t: 82 },
    ]);
    const clicks: ClickSample[] = [
      { seq: 1, x: 0, y: 0, t: 40, kind: 0, button: 0, trusted: 1 },
      { seq: 2, x: 0, y: 0, t: 82, kind: 0, button: 0, trusted: 1 },
    ];
    expect(mouseRouteToTarget(meander, clicks)).toBe(0);
    expect(mouseRouteToTarget([])).toBe(NEUTRAL);
  });

  it("L50 anticipación: destino esperado mucho antes -> 1, click inmediato -> 0", () => {
    const early = aimScenario(FOUR_AIMS.map((aim) => ({ ...aim, gapMs: 960 })));
    expect(mouseAnticipation(early.pointer, early.clicks)).toBe(1);
    const immediate = aimScenario(FOUR_AIMS);
    expect(mouseAnticipation(immediate.pointer, immediate.clicks)).toBe(0);
    expect(mouseAnticipation([])).toBe(NEUTRAL);
  });

  it("L51 hover antes de clickear: sin hover -> 1, reposo sobre destino -> 0", () => {
    const noHover = aimScenario(FOUR_AIMS);
    expect(mouseHoverBeforeClick(noHover.pointer, noHover.clicks)).toBe(1);
    const hover = aimScenario(FOUR_AIMS.map((aim) => ({ ...aim, gapMs: 200 })));
    expect(mouseHoverBeforeClick(hover.pointer, hover.clicks)).toBe(0);
    expect(mouseHoverBeforeClick([])).toBe(NEUTRAL);
  });

  it("L52 hover sobre irrelevantes: solo reposos con click -> 1, reposos sin click -> 0", () => {
    const withClick: PointerSample[] = [];
    const withClickClicks: ClickSample[] = [];
    let seq = 1;
    for (const base of [0, 1000]) {
      withClick.push({ seq: seq++, x: 0, y: 0, t: base, kind: 0, pointerType: 0, trusted: 1 });
      withClick.push({
        seq: seq++,
        x: 100,
        y: 0,
        t: base + 10,
        kind: 0,
        pointerType: 0,
        trusted: 1,
      });
      withClick.push({
        seq: seq++,
        x: 100,
        y: 0,
        t: base + 20,
        kind: 0,
        pointerType: 0,
        trusted: 1,
      });
      withClickClicks.push({
        seq: seq++,
        x: 100,
        y: 0,
        t: base + 70,
        kind: 0,
        button: 0,
        trusted: 1,
      });
      withClick.push({
        seq: seq++,
        x: 100,
        y: 0,
        t: base + 80,
        kind: 2,
        pointerType: 0,
        trusted: 1,
      });
    }
    expect(mouseHoverIrrelevant(withClick, withClickClicks)).toBe(1);
    expect(mouseHoverIrrelevant(withClick)).toBe(0);
    expect(mouseHoverIrrelevant([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// CLICKS (5 medidas)
// ---------------------------------------------------------------------------

describe("lane final · CLICKS", () => {
  it("L60 click sin movimiento previo: mismo punto -> 1, puntos distintos -> 0", () => {
    const same = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 0, y: 0, downT: 100, upT: 150 },
      { x: 0, y: 0, downT: 200, upT: 250 },
    ]);
    expect(clickNoPriorMovement(same)).toBe(1);
    const moved = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 100, y: 0, downT: 100, upT: 150 },
      { x: 200, y: 0, downT: 200, upT: 250 },
    ]);
    expect(clickNoPriorMovement(moved)).toBe(0);
    expect(clickNoPriorMovement([])).toBe(NEUTRAL);
  });

  it("L63 arrastre natural: deriva idéntica -> 1, deriva variable -> 0", () => {
    const fixed = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 0, y: 0, downT: 100, upT: 150 },
      { x: 0, y: 0, downT: 200, upT: 250 },
    ]).map((sample) => (sample.kind === 1 ? { ...sample, x: sample.x + 10 } : sample));
    expect(clickNaturalDrag(fixed)).toBe(1);
    const varied = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 0, y: 0, downT: 100, upT: 150 },
      { x: 0, y: 0, downT: 200, upT: 250 },
    ]).map((sample, index) =>
      sample.kind === 1 ? { ...sample, x: sample.x + [5, 20, 50][Math.floor(index / 2)] } : sample,
    );
    expect(clickNaturalDrag(varied)).toBe(0);
    expect(clickNaturalDrag([])).toBe(NEUTRAL);
  });

  it("L64 selección de texto: sin arrastre -> 1, arrastre sostenido -> 0", () => {
    const none = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 0, y: 0, downT: 100, upT: 150 },
      { x: 0, y: 0, downT: 200, upT: 250 },
    ]);
    expect(clickTextSelection(none)).toBe(1);
    const selecting = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 200 },
      { x: 0, y: 0, downT: 300, upT: 350 },
      { x: 0, y: 0, downT: 400, upT: 450 },
    ]).map((sample) => (sample.kind === 1 && sample.t === 200 ? { ...sample, x: 30 } : sample));
    expect(clickTextSelection(selecting)).toBe(0);
    expect(clickTextSelection([])).toBe(NEUTRAL);
  });

  it("L65 zonas no clickeables: siempre el mismo punto -> 1, puntos dispersos -> 0", () => {
    const same = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 0, y: 0, downT: 100, upT: 150 },
      { x: 0, y: 0, downT: 200, upT: 250 },
      { x: 0, y: 0, downT: 300, upT: 350 },
    ]);
    expect(clickNonInteractive(same)).toBe(1);
    const spread = clickPairs([
      { x: 0, y: 0, downT: 0, upT: 50 },
      { x: 100, y: 0, downT: 100, upT: 150 },
      { x: 200, y: 0, downT: 200, upT: 250 },
      { x: 300, y: 0, downT: 300, upT: 350 },
    ]);
    expect(clickNonInteractive(spread)).toBe(0);
    expect(clickNonInteractive([])).toBe(NEUTRAL);
  });

  it("L66 orden de los clicks: barrido monótono -> 1, saltos -> 0", () => {
    const scan = clickPairs(
      [0, 10, 20, 30].map((x, i) => ({ x, y: 0, downT: i * 100, upT: i * 100 + 50 })),
    );
    expect(clickOrder(scan)).toBe(1);
    const jumps = clickPairs(
      [0, 100, 0, 100].map((x, i) => ({ x, y: 0, downT: i * 100, upT: i * 100 + 50 })),
    );
    expect(clickOrder(jumps)).toBe(0);
    expect(clickOrder([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// TECLADO (9 medidas)
// ---------------------------------------------------------------------------

describe("lane final · TECLADO", () => {
  it("L74 solapamiento: eventos secuenciales -> 1, teclas solapadas -> 0", () => {
    const sequential = [
      key(1, 0, 0),
      key(2, 50, 1),
      key(3, 100, 0),
      key(4, 150, 1),
      key(5, 200, 0),
      key(6, 250, 1),
    ];
    expect(keyboardKeyOverlap(sequential)).toBe(1);
    const overlapping = [
      key(1, 0, 0),
      key(2, 20, 0),
      key(3, 40, 0),
      key(4, 60, 0),
      key(5, 80, 1),
      key(6, 100, 1),
      key(7, 120, 1),
      key(8, 140, 1),
    ];
    expect(keyboardKeyOverlap(overlapping)).toBe(0);
    expect(keyboardKeyOverlap([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L75 pares de letras: mismo intervalo por par -> 1, ritmo por par -> 0", () => {
    const uniform = downs([0, 1, 2, 0, 1, 2, 0, 1, 2], 100);
    expect(keyboardLetterPairs(uniform)).toBe(1);
    const varied = downs([0, 1, 2, 0, 1, 2, 0, 1, 2], 100).map((sample, index) => ({
      ...sample,
      t: [0, 50, 250, 650, 700, 900, 1300, 1350, 1550][index],
    }));
    expect(keyboardLetterPairs(varied)).toBe(0);
    expect(keyboardLetterPairs([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L76 cambio de mano (categoría numérica): sin ventaja -> 1, cambio más rápido -> 0", () => {
    const noAdvantage = downs([0, 0, 1, 1, 0, 0, 1, 1], 100).map((sample, index) => ({
      ...sample,
      t: [0, 80, 200, 280, 400, 480, 600, 680][index],
    }));
    expect(keyboardHandSwitch(noAdvantage)).toBe(1);
    const faster = downs([0, 0, 1, 1, 0, 0, 1, 1], 100).map((sample, index) => ({
      ...sample,
      t: [0, 120, 180, 300, 360, 480, 540, 660][index],
    }));
    expect(keyboardHandSwitch(faster)).toBe(0);
    expect(keyboardHandSwitch([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L77 misma tecla repetida: categoría fija -> 1, alternancia -> 0", () => {
    expect(keyboardRepeatedKey(downs(Array(6).fill(0), 100))).toBe(1);
    expect(keyboardRepeatedKey(downs([0, 1, 0, 1, 0, 1], 100))).toBe(0);
    expect(keyboardRepeatedKey([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L80 aceleración al calentar: ritmo fijo -> 1, acelera -> 0", () => {
    expect(keyboardWarmupAcceleration(downs(Array(9).fill(0), 100))).toBe(1);
    const faster = downs(Array(9).fill(0), 100).map((sample, index) => ({
      ...sample,
      t: index < 5 ? index * 200 : 800 + (index - 5) * 100,
    }));
    expect(keyboardWarmupAcceleration(faster)).toBe(0);
    expect(keyboardWarmupAcceleration([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L82 pausa antes de la primera tecla: arranque inmediato -> 1, espera -> 0", () => {
    expect(keyboardFirstKeyPause(downs(Array(4).fill(0), 100, 0))).toBe(1);
    expect(keyboardFirstKeyPause(downs(Array(4).fill(0), 100, 3000))).toBe(0);
    expect(keyboardFirstKeyPause([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L86 ritmo según cantidad de texto: ritmo fijo -> 1, ritmo creciente -> 0", () => {
    expect(keyboardRhythmByTextLength(downs(Array(8).fill(0), 100))).toBe(1);
    const growing = downs(Array(8).fill(0), 100).map((sample, index) => ({
      ...sample,
      t: index * (index + 1) * 50,
    }));
    expect(keyboardRhythmByTextLength(growing)).toBe(0);
    expect(keyboardRhythmByTextLength([])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L90 cero errores en texto largo: texto sin borrar -> 1, con borrar -> 0", () => {
    const keys = downs(Array(10).fill(0), 100);
    expect(keyboardZeroErrorsLongText(keys, inputs(10))).toBe(1);
    expect(keyboardZeroErrorsLongText([...keys, key(11, 1000, 0, 3)], inputs(10))).toBe(0);
    expect(keyboardZeroErrorsLongText([], [])).toBe(KEYBOARD_NEUTRAL);
  });

  it("L97 Tab para cambiar de campo: hueco regular -> 1, hueco irregular -> 0", () => {
    const regular = downs([7, 0, 7, 0, 7, 0, 7, 0], 100).map((sample, index) => ({
      ...sample,
      t: [0, 10, 100, 110, 200, 210, 300, 310][index],
    }));
    expect(keyboardTabUsage(regular)).toBe(1);
    const irregular = regular.map((sample, index) => ({
      ...sample,
      t: [0, 10, 100, 110, 350, 360, 800, 810][index],
    }));
    expect(keyboardTabUsage(irregular)).toBe(0);
    expect(keyboardTabUsage([])).toBe(KEYBOARD_NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// SCROLL (2 medidas)
// ---------------------------------------------------------------------------

describe("lane final · SCROLL", () => {
  it("L110 scroll proporcional: salto fijo -> 1, delta crece con el tiempo -> 0", () => {
    const fixed = scrolls([0, 0, 0, 0, 0], [100, 100, 100, 100, 100], [0, 10, 20, 30, 40]);
    expect(scrollProportional(fixed)).toBe(1);
    const growing = scrolls([0, 0, 0, 0, 0], [10, 20, 40, 80, 160], [0, 10, 30, 70, 150]);
    expect(scrollProportional(growing)).toBe(0);
    expect(scrollProportional([])).toBe(NEUTRAL);
  });

  it("L111 scroll sin otro movimiento: intervalos exactos -> 1, jitter -> 0", () => {
    const exact = scrolls([0, 0, 0, 0, 0], [10, 10, 10, 10, 10], [0, 20, 40, 60, 80]);
    expect(scrollNoOtherMovement(exact)).toBe(1);
    const jitter = scrolls([0, 0, 0, 0, 0], [10, 10, 10, 10, 10], [0, 20, 90, 130, 260]);
    expect(scrollNoOtherMovement(jitter)).toBe(0);
    expect(scrollNoOtherMovement([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// Integración: tablas, extractores masivos, invarianza y defensividad
// ---------------------------------------------------------------------------

describe("lane final · integración aditiva", () => {
  it("las 4 tablas nuevas tienen exactamente 35 claves y todas valen 0", () => {
    const tables = [
      MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS,
      CLICK_FINAL_PARTIAL_FEATURE_WEIGHTS,
      SCROLL_FINAL_PARTIAL_FEATURE_WEIGHTS,
      KEYBOARD_FINAL_FEATURE_WEIGHTS,
    ];
    expect(tables.reduce((acc, table) => acc + Object.keys(table).length, 0)).toBe(35);
    for (const table of tables) {
      for (const weight of Object.values(table)) expect(weight).toBe(0);
      expect(Object.isFrozen(table)).toBe(true);
    }
  });

  it("las tablas y extractores existentes siguen intactos", () => {
    expect(Object.keys(MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(19);
    expect(Object.keys(CLICK_FINAL_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(5);
    expect(Object.keys(KEYBOARD_FINAL_FEATURE_WEIGHTS)).toHaveLength(9);
    expect(Object.keys(SCROLL_FINAL_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(2);
    // Carriles previos: sus firmas y número de claves no cambian.
    expect(Object.keys(MOUSE_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(15);
    expect(Object.keys(CLICK_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(3);
    expect(Object.keys(SCROLL_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(2);
    expect(Object.keys(extractPartialMouseFeatures([]))).toHaveLength(15);
    expect(Object.keys(extractPartialClickFeatures([]))).toHaveLength(3);
    expect(Object.keys(extractPartialScrollFeatures([]))).toHaveLength(2);
  });

  it("los extractores finales devuelven 35 valores finitos en [0,1] y neutros con entrada vacía", () => {
    const scenario = aimScenario(FOUR_AIMS);
    const mouseFeatures = extractFinalMouseFeatures(scenario.pointer, scenario.clicks);
    const clickFeatures = extractFinalClickFeatures(
      clickPairs([
        { x: 0, y: 0, downT: 0, upT: 50 },
        { x: 100, y: 0, downT: 100, upT: 150 },
        { x: 200, y: 0, downT: 200, upT: 250 },
      ]),
    );
    const keyboardFeatures = extractFinalKeyboardFeatures(downs(Array(12).fill(0), 80), inputs(10));
    const scrollFeatures = extractFinalScrollFeatures(
      scrolls([0, 0, 0, 0], [10, 20, 30, 40], [0, 20, 40, 60]),
    );
    const all = [
      ...Object.values(mouseFeatures),
      ...Object.values(clickFeatures),
      ...Object.values(keyboardFeatures),
      ...Object.values(scrollFeatures),
    ];
    expect(all).toHaveLength(35);
    for (const value of all) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    const empty = [
      ...Object.values(extractFinalMouseFeatures([], [])),
      ...Object.values(extractFinalClickFeatures([])),
      ...Object.values(extractFinalKeyboardFeatures([], [])),
      ...Object.values(extractFinalScrollFeatures([])),
    ];
    for (const value of empty) expect(value).toBe(NEUTRAL);
  });

  it("las nuevas medidas no alteran computeKeyboardScore", () => {
    const base = extractKeyboardFeatures(downs(Array(30).fill(0), 60), []);
    const zeros = { ...base } as KeyboardFeatures;
    const ones = { ...base } as KeyboardFeatures;
    for (const name of Object.keys(KEYBOARD_FINAL_FEATURE_WEIGHTS) as Array<
      keyof typeof KEYBOARD_FINAL_FEATURE_WEIGHTS
    >) {
      zeros[name] = 0;
      ones[name] = 1;
    }
    expect(computeKeyboardScore(zeros)).toBe(computeKeyboardScore(ones));
  });

  it("muestras hostiles (NaN/Infinity/1e308) devuelven siempre un número finito", () => {
    const hostilePointer = points([
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, t: Number.NEGATIVE_INFINITY },
      { x: 1e308, y: -1e308, t: 1e308 },
      { x: Number.NaN, y: Number.NaN, t: Number.NaN },
    ]);
    const hostileClicks: ClickSample[] = [
      {
        seq: 1,
        x: Number.NaN,
        y: 1e308,
        t: Number.POSITIVE_INFINITY,
        kind: 0,
        button: NaN,
        trusted: 1,
      },
      { seq: 2, x: 1e308, y: Number.NaN, t: Number.NaN, kind: 1, button: 0, trusted: 1 },
    ];
    const hostileScroll = scrolls(
      [Number.NaN, 1e308, 0],
      [Number.POSITIVE_INFINITY, -1e308, 1],
      [Number.NaN, 1e308, 1],
    );
    const hostileKeys = [
      key(1, Number.NaN, 0, 0),
      key(2, 1e308, 0, 7),
      key(3, Number.POSITIVE_INFINITY, 1, 3),
    ];
    const hostileInputs = inputs(3).map((sample) => ({ ...sample, t: Number.NaN }));

    const values = [
      ...Object.values(extractFinalMouseFeatures(hostilePointer, hostileClicks)),
      ...Object.values(extractFinalClickFeatures(hostileClicks)),
      ...Object.values(extractFinalScrollFeatures(hostileScroll)),
      ...Object.values(extractFinalKeyboardFeatures(hostileKeys, hostileInputs)),
    ];
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
