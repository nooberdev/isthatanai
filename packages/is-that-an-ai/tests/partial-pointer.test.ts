// Pruebas deterministas de las medidas PARCIALES del checklist (carril ~):
// mouse/click/scroll. Todas son funciones puras sobre muestras numéricas.
// Comprueba un caso discriminante por ítem, el rango [0,1] y la convención
// NEUTRAL (0.5) con entrada vacía.

import { describe, expect, it } from "bun:test";
import {
  CLICK_NEUTRAL,
  CLICK_PARTIAL_FEATURE_WEIGHTS,
  clickDoubleClickRhythm,
  clickInstantaneous,
  clickSecondaryButtons,
  extractPartialClickFeatures,
} from "../src/features/click";
import {
  extractPartialMouseFeatures,
  MOUSE_PARTIAL_FEATURE_WEIGHTS,
  mouseAverageSpeed,
  mouseBellProfile,
  mouseClickPrecision,
  mouseCorrectedMisses,
  mouseCurvature,
  mouseDeviceType,
  mouseDirectionChanges,
  mouseEdgeEntries,
  mouseFineCorrection,
  mouseImpossibleSpeed,
  mouseLargeJumps,
  mouseSpeedVariation,
  mouseSubpixel,
  mouseTemporalResolution,
  mouseZigzag,
  NEUTRAL,
} from "../src/features/mouse";
import {
  extractPartialScrollFeatures,
  SCROLL_NEUTRAL,
  SCROLL_PARTIAL_FEATURE_WEIGHTS,
  scrollInstantEnd,
  scrollSpeed,
} from "../src/features/scroll";
import type { ClickSample, PointerSample, ScrollSample } from "../src/types";

interface RawPoint {
  x: number;
  y: number;
  t: number;
  kind?: 0 | 1 | 2;
  pointerType?: 0 | 1 | 2 | 3;
}

function points(raw: RawPoint[]): PointerSample[] {
  return raw.map((point, index) => ({
    seq: index + 1,
    x: point.x,
    y: point.y,
    t: point.t,
    kind: point.kind ?? 0,
    pointerType: point.pointerType ?? 0,
    trusted: 1,
  }));
}

/** Pasos de (dx,dy) cada dt ms, empezando en (0,0). */
function line(dx: number, dy: number, count: number, dt = 10): PointerSample[] {
  return points(
    Array.from({ length: count }, (_, index) => ({
      x: index * dx,
      y: index * dy,
      t: index * dt,
    })),
  );
}

interface PairSpec {
  x: number;
  y: number;
  downT: number;
  upT: number;
  button?: number;
}

function clicks(pairs: PairSpec[]): ClickSample[] {
  const out: ClickSample[] = [];
  let seq = 0;
  for (const pair of pairs) {
    const button = pair.button ?? 0;
    out.push({
      seq: ++seq,
      x: pair.x,
      y: pair.y,
      t: pair.downT,
      kind: 0,
      button,
      trusted: 1,
    });
    out.push({
      seq: ++seq,
      x: pair.x,
      y: pair.y,
      t: pair.upT,
      kind: 1,
      button,
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

describe("MOUSE trayectoria (parcial)", () => {
  it("L3 curvatura: recta -> 0, giros amplios -> alto, vacío -> neutro", () => {
    expect(mouseCurvature(line(10, 0, 6))).toBe(0);
    const square = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 10, y: 10, t: 20 },
      { x: 0, y: 10, t: 30 },
    ]);
    expect(mouseCurvature(square)).toBeGreaterThan(0.9);
    expect(mouseCurvature([])).toBe(NEUTRAL);
  });

  it("L4 cambios de dirección: recta -> 0, zigzag -> alto, vacío -> neutro", () => {
    expect(mouseDirectionChanges(line(10, 0, 6))).toBe(0);
    const zig = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 10, y: 10, t: 20 },
      { x: 0, y: 10, t: 30 },
      { x: 0, y: 0, t: 40 },
    ]);
    expect(mouseDirectionChanges(zig)).toBeGreaterThan(0.9);
    expect(mouseDirectionChanges([])).toBe(NEUTRAL);
  });

  it("L7 saltos grandes: paso desproporcionado -> 1, pasos uniformes -> 0", () => {
    const jump = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 30, y: 0, t: 30 },
      { x: 10_000, y: 0, t: 40 },
    ]);
    expect(mouseLargeJumps(jump)).toBe(1);
    expect(mouseLargeJumps(line(10, 0, 6))).toBe(0);
    expect(mouseLargeJumps([])).toBe(NEUTRAL);
  });

  it("L9 zigzag: desviación lateral alterna -> alto, recta -> 0", () => {
    const zig = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 5, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 30, y: 5, t: 30 },
      { x: 40, y: 0, t: 40 },
    ]);
    expect(mouseZigzag(zig)).toBeGreaterThan(0.9);
    expect(mouseZigzag(line(10, 0, 6))).toBe(0);
    expect(mouseZigzag([])).toBe(NEUTRAL);
  });

  it("L15 entradas por el borde: entrada lejana -> 1, cercana -> 0", () => {
    const abrupt = points([
      { x: 0, y: 0, t: 0 },
      { x: 20, y: 0, t: 10 },
      { x: 1_000, y: 1_000, t: 20, kind: 1 },
    ]);
    const gentle = points([
      { x: 0, y: 0, t: 0 },
      { x: 20, y: 0, t: 10 },
      { x: 23, y: 2, t: 20, kind: 1 },
    ]);
    expect(mouseEdgeEntries(abrupt)).toBe(1);
    expect(mouseEdgeEntries(gentle)).toBe(0);
    expect(mouseEdgeEntries(line(10, 0, 4))).toBe(NEUTRAL);
    expect(mouseEdgeEntries([])).toBe(NEUTRAL);
  });
});

describe("MOUSE velocidad (parcial)", () => {
  it("L18 velocidad promedio: rápida -> 1, lenta -> 0", () => {
    expect(mouseAverageSpeed(line(100, 0, 4))).toBe(1); // 10 px/ms
    expect(mouseAverageSpeed(line(1, 0, 4))).toBe(0); // 0.1 px/ms
    expect(mouseAverageSpeed([])).toBe(NEUTRAL);
  });

  it("L20 perfil de campana: campana -> 0, plana -> 1", () => {
    const bell = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 30, y: 0, t: 20 },
      { x: 80, y: 0, t: 30 },
      { x: 100, y: 0, t: 40 },
      { x: 110, y: 0, t: 50 },
    ]);
    expect(mouseBellProfile(bell)).toBe(0);
    expect(mouseBellProfile(line(10, 0, 6))).toBe(1);
    expect(mouseBellProfile([])).toBe(NEUTRAL);
  });

  it("L25 variación entre movimientos: ritmo único -> 1, ritmos distintos -> bajo", () => {
    const repeated = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 0, y: 0, t: 30, kind: 2 },
      { x: 0, y: 0, t: 40 },
      { x: 10, y: 0, t: 50 },
      { x: 20, y: 0, t: 60 },
    ]);
    const varied = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 0, y: 0, t: 30, kind: 2 },
      { x: 0, y: 0, t: 40 },
      { x: 20, y: 0, t: 50 },
      { x: 40, y: 0, t: 60 },
    ]);
    expect(mouseSpeedVariation(repeated)).toBe(1);
    expect(mouseSpeedVariation(varied)).toBeLessThan(0.3);
    expect(mouseSpeedVariation([])).toBe(NEUTRAL);
  });

  it("L27 velocidad imposible: salto veloz -> 1, lento -> 0", () => {
    const fast = points([
      { x: 0, y: 0, t: 0 },
      { x: 1_000, y: 0, t: 10 },
    ]);
    expect(mouseImpossibleSpeed(fast)).toBe(1);
    expect(mouseImpossibleSpeed(line(1, 0, 4))).toBe(0);
    expect(mouseImpossibleSpeed([])).toBe(NEUTRAL);
  });

  it("L31 resolución temporal: ms enteros -> 1, decimales -> 0", () => {
    expect(mouseTemporalResolution(line(10, 0, 5))).toBe(1);
    const fractional = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10.25 },
      { x: 20, y: 0, t: 20.5 },
      { x: 30, y: 0, t: 30.75 },
    ]);
    expect(mouseTemporalResolution(fractional)).toBe(0);
    expect(mouseTemporalResolution([])).toBe(NEUTRAL);
  });
});

describe("MOUSE temblor y dispositivo (parcial)", () => {
  it("L35 subpíxel: coordenadas enteras -> 1, fraccionarias -> 0", () => {
    expect(mouseSubpixel(line(10, 0, 5))).toBe(1);
    const fractional = points([
      { x: 0.25, y: 0.5, t: 0 },
      { x: 10.75, y: 0.5, t: 10 },
    ]);
    expect(mouseSubpixel(fractional)).toBe(0);
    expect(mouseSubpixel([])).toBe(NEUTRAL);
  });

  it("L36 tipo de dispositivo: solo pointerType, valor normalizado", () => {
    expect(mouseDeviceType(line(10, 0, 4))).toBe(0); // mouse
    expect(mouseDeviceType(points([{ x: 0, y: 0, t: 0, pointerType: 2 }]))).toBeCloseTo(2 / 3, 9);
    expect(mouseDeviceType(points([{ x: 0, y: 0, t: 0, pointerType: 1 }]))).toBeCloseTo(1 / 3, 9);
    expect(mouseDeviceType([])).toBe(NEUTRAL);
  });
});

describe("MOUSE puntería (parcial)", () => {
  it("L43 corrección fina: micro-ajuste final -> 0, sin ajuste -> 1", () => {
    const corrected = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 30, y: 0, t: 30 },
      { x: 32, y: 0, t: 40 },
    ]);
    expect(mouseFineCorrection(corrected)).toBe(0);
    expect(mouseFineCorrection(line(10, 0, 5))).toBe(1);
    expect(mouseFineCorrection([])).toBe(NEUTRAL);
  });

  it("L46 precisión del click: mismo punto -> 1, puntos dispersos -> 0", () => {
    const same = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 0, y: 0, t: 20, kind: 2 },
      { x: 0, y: 0, t: 30 },
      { x: 100, y: 0, t: 40 },
      { x: 0, y: 0, t: 50, kind: 2 },
      { x: 0, y: 0, t: 60 },
      { x: 100, y: 0, t: 70 },
    ]);
    const spread = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 0, y: 0, t: 20, kind: 2 },
      { x: 0, y: 0, t: 30 },
      { x: 1_000, y: 0, t: 40 },
      { x: 0, y: 0, t: 50, kind: 2 },
      { x: 0, y: 0, t: 60 },
      { x: -1_000, y: 0, t: 70 },
    ]);
    expect(mouseClickPrecision(same)).toBe(1);
    expect(mouseClickPrecision(spread)).toBe(0);
    expect(mouseClickPrecision([])).toBe(NEUTRAL);
  });

  it("L48 fallos corregidos: vuelve atrás al final -> 0, sin fallo -> 1", () => {
    const corrected = points([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 10 },
      { x: 90, y: 0, t: 20 },
    ]);
    expect(mouseCorrectedMisses(corrected)).toBe(0);
    expect(mouseCorrectedMisses(line(10, 0, 5))).toBe(1);
    expect(mouseCorrectedMisses([])).toBe(NEUTRAL);
  });

  it("extractPartialMouseFeatures: 15 medidas en [0,1], neutros y pesos 0", () => {
    const features = extractPartialMouseFeatures(line(10, 0, 6));
    expect(Object.keys(features)).toHaveLength(15);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of Object.values(extractPartialMouseFeatures([]))) {
      expect(value).toBe(NEUTRAL);
    }
    expect(Object.values(MOUSE_PARTIAL_FEATURE_WEIGHTS).every((w) => w === 0)).toBe(true);
    expect(Object.keys(MOUSE_PARTIAL_FEATURE_WEIGHTS)).toHaveLength(15);
  });
});

describe("CLICKS parciales", () => {
  it("L55 click instantáneo: duración 0 -> 1, duración normal -> 0", () => {
    const instant = clicks([
      { x: 0, y: 0, downT: 0, upT: 0 },
      { x: 0, y: 0, downT: 100, upT: 100 },
      { x: 0, y: 0, downT: 200, upT: 200 },
    ]);
    const normal = clicks([0, 100, 200].map((downT) => ({ x: 0, y: 0, downT, upT: downT + 60 })));
    expect(clickInstantaneous(instant)).toBe(1);
    expect(clickInstantaneous(normal)).toBe(0);
    expect(clickInstantaneous([])).toBe(CLICK_NEUTRAL);
  });

  it("L58 ritmo del doble click: intervalos idénticos -> 1, irregulares -> 0", () => {
    const exact = clicks(
      [0, 100, 200, 300].map((downT) => ({
        x: 0,
        y: 0,
        downT,
        upT: downT + 40,
      })),
    );
    const irregular = clicks(
      [0, 100, 350, 700].map((downT) => ({
        x: 0,
        y: 0,
        downT,
        upT: downT + 40,
      })),
    );
    const single = clicks(
      [0, 1_000, 2_000, 3_000].map((downT) => ({
        x: 0,
        y: 0,
        downT,
        upT: downT + 40,
      })),
    );
    expect(clickDoubleClickRhythm(exact)).toBe(1);
    expect(clickDoubleClickRhythm(irregular)).toBe(0);
    expect(clickDoubleClickRhythm(single)).toBe(0);
    expect(clickDoubleClickRhythm([])).toBe(CLICK_NEUTRAL);
  });

  it("L62 botón derecho/medio: solo primario -> 1, secundario -> 0", () => {
    const primary = clicks([0, 100, 200].map((downT) => ({ x: 0, y: 0, downT, upT: downT + 60 })));
    const mixed = [
      ...primary,
      { seq: 7, x: 5, y: 5, t: 400, kind: 0 as const, button: 2, trusted: 1 as const },
    ];
    expect(clickSecondaryButtons(primary)).toBe(1);
    expect(clickSecondaryButtons(mixed)).toBe(0);
    expect(clickSecondaryButtons([])).toBe(CLICK_NEUTRAL);
  });

  it("extractPartialClickFeatures: 3 medidas, pesos 0, neutros sin datos", () => {
    const features = extractPartialClickFeatures(
      clicks([0, 100, 200].map((downT) => ({ x: 0, y: 0, downT, upT: downT + 60 }))),
    );
    expect(Object.keys(features)).toHaveLength(3);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of Object.values(extractPartialClickFeatures([]))) {
      expect(value).toBe(CLICK_NEUTRAL);
    }
    expect(Object.values(CLICK_PARTIAL_FEATURE_WEIGHTS).every((w) => w === 0)).toBe(true);
  });
});

describe("SCROLL parcial", () => {
  it("L104 velocidad del scroll: rápida -> 1, lenta -> 0", () => {
    const fast = scrolls([0, 0, 0, 0], [100, 100, 100, 100], [0, 10, 20, 30]);
    const slow = scrolls([0, 0, 0, 0], [1, 1, 1, 1], [0, 10, 20, 30]);
    expect(scrollSpeed(fast)).toBe(1);
    expect(scrollSpeed(slow)).toBe(0);
    expect(scrollSpeed([])).toBe(SCROLL_NEUTRAL);
  });

  it("L112 scroll instantáneo hasta el final: salto único -> 1, gradual -> 0", () => {
    const instant = scrolls([0, 0], [1_500, 0], [0, 10]);
    const gradual = scrolls([0, 0], [100, 100], [0, 10]);
    expect(scrollInstantEnd(instant)).toBe(1);
    expect(scrollInstantEnd(gradual)).toBe(0);
    expect(scrollInstantEnd([])).toBe(SCROLL_NEUTRAL);
  });

  it("extractPartialScrollFeatures: 2 medidas, pesos 0, neutros sin datos", () => {
    const features = extractPartialScrollFeatures(
      scrolls([0, 0, 0, 0], [100, 100, 100, 100], [0, 10, 20, 30]),
    );
    expect(Object.keys(features)).toHaveLength(2);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of Object.values(extractPartialScrollFeatures([]))) {
      expect(value).toBe(SCROLL_NEUTRAL);
    }
    expect(Object.values(SCROLL_PARTIAL_FEATURE_WEIGHTS).every((w) => w === 0)).toBe(true);
  });
});
