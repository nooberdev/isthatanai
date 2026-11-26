// Auditoría REALISTA de todos los ítems de mouse del checklist (L2-L52).
//
// Cada caso usa PointerSample/ClickSample reales (coords fraccionarias,
// timestamps irregulares, fronteras kind 1|2, ráfagas coalescidas) y comprueba
// dos cosas: (1) el valor es finito en [0,1] y (2) el valor es SEMÁNTICAMENTE
// correcto según la dirección documentada de cada medida (1 = más IA salvo
// `overshoot`/`turnSmoothness`, que el scoring invierte y son 1 = humano).
//
// Este archivo es solo de verificación: no cambia ningún score calibrado.

import { describe, expect, it } from "bun:test";
import {
  extractFinalMouseFeatures,
  extractMouseFeatures,
  extractPartialMouseFeatures,
  MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS,
  MOUSE_PARTIAL_FEATURE_WEIGHTS,
  mouseAimTime,
  mouseAnticipation,
  mouseAverageSpeed,
  mouseBellProfile,
  mouseClickPrecision,
  mouseCorrectedMisses,
  mouseCurvature,
  mouseDeviceType,
  mouseDirectionChanges,
  mouseDriftAfterRelease,
  mouseEdgeEntries,
  mouseExactRepetition,
  mouseFavoriteDirections,
  mouseFinalBraking,
  mouseFineCorrection,
  mouseFittsLaw,
  mouseHoverBeforeClick,
  mouseHoverIrrelevant,
  mouseImpossibleSpeed,
  mouseInitialAcceleration,
  mouseIntervalRegularity,
  mouseJerk,
  mouseLargeJumps,
  mouseMaxSpeed,
  mouseMicroPauses,
  mouseMovementOrigin,
  mouseOvershoot,
  mousePerfectCurves,
  mouseRestStability,
  mouseRoundSteps,
  mouseRouteToTarget,
  mouseSpeedByDistance,
  mouseSpeedUniformity,
  mouseSpeedVariation,
  mouseStillBeforeMove,
  mouseStraightness,
  mouseSubpixel,
  mouseSymmetry,
  mouseTeleport,
  mouseTemporalResolution,
  mouseThinkingDrift,
  mouseTimeToClick,
  mouseTremor,
  mouseTurnSmoothness,
  mouseZigzag,
  NEUTRAL,
} from "../../src/features/mouse";
import type { ClickSample, PointerSample } from "../../src/types";

// ---------------------------------------------------------------------------
// Constructores (formas reales de PointerSample / ClickSample)
// ---------------------------------------------------------------------------

let seq = 1;
function p(
  x: number,
  y: number,
  t: number,
  kind: 0 | 1 | 2 = 0,
  pointerType: 0 | 1 | 2 | 3 = 0,
): PointerSample {
  return { seq: seq++, x, y, t, kind, pointerType, trusted: 1 };
}
function c(x: number, y: number, t: number): ClickSample {
  return { seq: seq++, x, y, t, kind: 0, button: 0, trusted: 1 };
}
function from(points: Array<[number, number, number]>): PointerSample[] {
  return points.map(([x, y, t]) => p(x, y, t));
}
function unit(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}
function zoom(samples: PointerSample[], factor: number): PointerSample[] {
  return samples.map((sample) => ({ ...sample, x: sample.x * factor, y: sample.y * factor }));
}

// Un acercamiento Fitts de mano: perfil de velocidad en campana, arco suave,
// micro-ruido subpíxel, sobrepaso y tres correcciones finas al llegar.
function humanFittsBell(): PointerSample[] {
  const out: PointerSample[] = [];
  const sx = 140.2,
    sy = 90.4,
    tx = 640.8,
    ty = 370.6;
  const dx = tx - sx,
    dy = ty - sy;
  const n = 18;
  const weights = Array.from({ length: n }, (_, i) => Math.sin((Math.PI * (i + 0.5)) / n) ** 0.85);
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = 1000.37;
  for (let i = 0; i < n; i += 1) {
    const f = weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / sum;
    const arc = Math.sin(f * Math.PI) * 9;
    const wob = Math.sin(i * 1.9) * 0.4;
    out.push(p(sx + dx * f + wob, sy + dy * f - arc + wob * 0.5, t));
    t += 9 + (i % 4) * 1.7 + 0.23;
  }
  out.push(p(tx + 8.3, ty + 4.1, t));
  t += 18.2;
  out.push(p(tx + 2.2, ty + 1.1, t));
  t += 21.4;
  out.push(p(tx + 0.3, ty - 0.2, t));
  t += 24.1;
  out.push(p(tx + 0.1, ty + 0.1, t));
  return out;
}

// Bot: interpolación lineal, cadencia fija de 16.67ms y coords enteras.
function botLinear(): PointerSample[] {
  return Array.from({ length: 16 }, (_, i) =>
    p(100 + Math.round((800 * i) / 15), 100 + Math.round((400 * i) / 15), 2000 + i * 16.67),
  );
}

// Usuario que duda antes de moverse: jitter subpíxel en reposo y luego sale.
function pauseThenMove(): PointerSample[] {
  const out: PointerSample[] = [];
  let t = 0;
  for (let i = 0; i < 6; i += 1) {
    out.push(p(300 + Math.sin(i * 2.1) * 0.15, 200 + Math.cos(i * 1.3) * 0.15, t));
    t += 90 + (i % 3) * 7;
  }
  t += 260;
  for (let i = 1; i <= 8; i += 1) {
    out.push(p(300 + i * 30, 200 + i * 12, t));
    t += 14 + (i % 4) * 2;
  }
  return out;
}

function tremorHuman(): PointerSample[] {
  const out: PointerSample[] = [];
  let t = 0;
  for (let i = 0; i < 14; i += 1) {
    out.push(
      p(
        100 + i * 22.3 + Math.sin(i * 3) * 0.3,
        200 + (i % 2 ? 1.7 : -1.7) + Math.cos(i * 2.2) * 0.25,
        t,
      ),
    );
    t += 9.3 + (i % 3) * 0.8;
  }
  return out;
}
function tremorBot(): PointerSample[] {
  return Array.from({ length: 14 }, (_, i) => p(100 + i * 22.3, 200, i * 9.3));
}

function smoothArc(): PointerSample[] {
  return Array.from({ length: 12 }, (_, i) => {
    const a = -0.6 + i * 0.12;
    return p(400 + 180 * Math.cos(a), 300 + 180 * Math.sin(a), i * 11.3);
  });
}
function hardCorners(): PointerSample[] {
  return from([
    [0, 0, 0],
    [80, 0, 14],
    [80, 80, 28],
    [160, 80, 42],
    [160, 0, 56],
    [240, 0, 70],
  ]);
}
function circleBot(): PointerSample[] {
  return Array.from({ length: 9 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 8;
    return p(300 + 100 * Math.cos(a), 300 + 100 * Math.sin(a), i * 12);
  });
}

// Usuario que rodea un modal que acaba de aparecer.
function detour(): PointerSample[] {
  return from([
    [0, 0, 0],
    [160, -170, 22],
    [320, -150, 45],
    [480, 0, 70],
    [500, 0, 82],
    [498.4, 0.3, 95],
  ]);
}
function straightToTarget(): PointerSample[] {
  return from([
    [0, 0, 0],
    [100, 0, 16],
    [200, 0, 32],
    [300, 0, 48],
    [400, 0, 64],
    [500, 0, 80],
  ]);
}

function outAndBack(mirror: boolean): PointerSample[] {
  const forward = Array.from(
    { length: 6 },
    (_, i) => [i * 30, i * 8, i * 14] as [number, number, number],
  );
  const back = Array.from({ length: 6 }, (_, i) => {
    const x = (5 - i) * 30;
    const y = (5 - i) * 8;
    // Vuelta humana: arco pronunciado, no el calco exacto de la ida.
    return [
      mirror ? x : x + 18 * Math.sin((i * Math.PI) / 5),
      mirror ? y : y + 45 * Math.sin((i * Math.PI) / 5),
      (6 + i) * 14,
    ] as [number, number, number];
  });
  return from([...forward, ...back]);
}

function exactReplay(): PointerSample[] {
  const run = (base: number): PointerSample[] =>
    Array.from({ length: 6 }, (_, i) => p(100 + i * 25, 100 + i * 10, base + i * 12));
  return [...run(0), p(225, 150, 80, 2), ...run(500)];
}
function variedReplay(): PointerSample[] {
  const first = Array.from({ length: 6 }, (_, i) => p(100 + i * 25, 100 + i * 10, i * 12));
  const second = Array.from({ length: 6 }, (_, i) =>
    p(100 + i * 25 + Math.sin(i) * 9, 100 + i * 10 + Math.cos(i) * 7, 500 + i * 12),
  );
  return [...first, p(225, 150, 80, 2), ...second];
}

function teleportBot(): PointerSample[] {
  return from([
    [0, 0, 0],
    [10, 0, 12],
    [20, 0, 24],
    [30, 0, 36],
    [730, 0, 44],
    [740, 0, 56],
    [750, 0, 68],
  ]);
}
function zeroDtBurst(): PointerSample[] {
  return [
    p(10, 10, 100),
    p(10.2, 10.1, 100),
    p(10.4, 10.3, 100),
    p(11, 11, 116),
    p(20, 19, 132),
    p(35, 33, 149),
  ];
}
function frozen(): PointerSample[] {
  return Array.from({ length: 5 }, (_, i) => p(500, 400, i * 16));
}
function microDrift(): PointerSample[] {
  return Array.from({ length: 5 }, (_, i) =>
    p(500 + Math.sin(i * 2) * 0.3, 400 + Math.cos(i * 2) * 0.3, i * 16),
  );
}
function fastFlick(): PointerSample[] {
  return Array.from({ length: 8 }, (_, i) => p(i * 80, 0, i * 10));
}
function slowCareful(): PointerSample[] {
  return Array.from({ length: 8 }, (_, i) => p(i, i * 0.5, i * 25));
}
function jitteryHuman(): PointerSample[] {
  // Correcciones bruscas reales: saltos alternos de 1px y ~90px cada 8ms.
  return from([
    [0, 0, 0],
    [1, 0, 8],
    [91, 0, 16],
    [93, 0, 24],
    [173, 0, 32],
    [174, 0, 40],
    [244, 0, 48],
  ]);
}
function regularCadence(dt: number, integer = false): PointerSample[] {
  return Array.from({ length: 12 }, (_, i) =>
    p(100 + i * 10, 100 + i * 5, integer ? i * Math.round(dt) : i * dt),
  );
}
function irregularCadence(): PointerSample[] {
  const dts = [8.3, 11.7, 9.1, 80.4, 8.8, 10.2, 7.9, 15.6, 9.4, 55.1, 8.6];
  let t = 0;
  const out = [p(100, 100, t)];
  for (const dt of dts) {
    t += dt;
    out.push(p(100 + out.length * 10, 100, t));
  }
  return out;
}
function humanWithPauses(): PointerSample[] {
  const dts = [16, 16, 66, 16, 16, 16, 71, 16, 16, 16, 16];
  let t = 0;
  const out = [p(0, 0, t)];
  for (const dt of dts) {
    t += dt;
    out.push(p(out.length * 12, 0, t));
  }
  return out;
}
function longWait(): PointerSample[] {
  return from([
    [0, 0, 0],
    [10, 0, 600],
    [20, 0, 612],
    [30, 0, 624],
    [40, 0, 636],
  ]);
}
function irregularWait(): PointerSample[] {
  return from([
    [0, 0, 0],
    [10, 0, 18],
    [20, 0, 31],
    [30, 0, 49],
    [40, 0, 63],
  ]);
}
function segmentsWithSpeeds(speeds: number[]): PointerSample[] {
  const out: PointerSample[] = [];
  let base = 0;
  for (const speed of speeds) {
    out.push(p(0, 0, base));
    out.push(p(speed * 10, 0, base + 10));
    out.push(p(speed * 10, 0, base + 11, 2));
    base += 1000;
  }
  return out;
}

interface AimSet {
  pointer: PointerSample[];
  clicks: ClickSample[];
}
function aims(human: boolean, detourToTarget = false, gapMs?: number): AimSet {
  const pointer: PointerSample[] = [];
  const clicks: ClickSample[] = [];
  let base = 0;
  const distances = human ? [80, 240, 520, 980] : [200, 200, 200, 200];
  for (let k = 0; k < 4; k += 1) {
    const dist = distances[k];
    const timeMs = human ? Math.round(60 + 105 * Math.log1p(dist / 40)) : 100;
    const gap = gapMs ?? (human ? 70 + k * 19 : 0);
    const steps = 6;
    pointer.push(p(0, 0, base));
    for (let i = 1; i <= steps; i += 1) {
      const f = i / steps;
      const x = detourToTarget ? dist * f : dist * f + (human ? Math.sin(i * 2.3 + k) * 1.6 : 0);
      const y = detourToTarget
        ? -dist * Math.sin(f * Math.PI)
        : human
          ? Math.sin(f * Math.PI) * 7 + Math.cos(i * 1.7) * 0.7
          : 0;
      pointer.push(p(x, y, base + (timeMs * i) / steps));
    }
    const ex = human ? dist + [1.4, -2.1, 0.8, -1.2][k] : dist;
    const ey = human ? [0.6, -1.3, 1.9, -0.7][k] : 0;
    clicks.push(c(ex, ey, base + timeMs + gap));
    pointer.push(p(ex, ey, base + timeMs + gap + 1, 2));
    base += timeMs + gap + 900;
  }
  return { pointer, clicks };
}
function hovers(human: boolean): AimSet {
  const pointer: PointerSample[] = [];
  const clicks: ClickSample[] = [];
  let base = 0;
  for (let k = 0; k < 5; k += 1) {
    const target = 100 + k * 90;
    pointer.push(p(0, 0, base));
    pointer.push(p(target, 0, base + 60));
    pointer.push(p(target, 0, base + 75));
    if (!human || k % 2 === 0) clicks.push(c(target, 0, base + 150));
    pointer.push(p(target, 0, base + 160, 2));
    base += 1000;
  }
  return { pointer, clicks };
}

// ---------------------------------------------------------------------------
// 🖱️ TRAYECTORIA (L2-L16)
// ---------------------------------------------------------------------------

describe("checklist mouse · trayectoria (realista)", () => {
  it("L2 Rectitud: humano que rodea un modal < 0.6; bot recto = 1", () => {
    const human = mouseStraightness(detour());
    const bot = mouseStraightness(straightToTarget());
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.6);
    expect(bot).toBeCloseTo(1, 6);
  });

  it("L3 Curvatura: círculo de bot > curva suave humana > recta", () => {
    const bot = mouseCurvature(circleBot());
    const human = mouseCurvature(smoothArc());
    const straight = mouseCurvature(straightToTarget());
    [bot, human, straight].forEach(unit);
    expect(bot).toBeGreaterThan(human);
    expect(human).toBeGreaterThan(straight);
    expect(straight).toBe(0);
    // Fix: pausa con jitter subpíxel ya NO cuenta como curvatura.
    expect(mouseCurvature(pauseThenMove())).toBe(0);
  });

  it("L4 Cambios de dirección: zigzag humano alto; pausa con jitter = 0; recta = 0", () => {
    const zig = from([
      [0, 0, 0],
      [10, 0, 10],
      [10, 10, 20],
      [0, 10, 30],
      [0, 0, 40],
    ]);
    const changes = mouseDirectionChanges(zig);
    unit(changes);
    expect(changes).toBeGreaterThan(0.9);
    // Fix: micro-ruido en reposo no giraba "intencionalmente".
    expect(mouseDirectionChanges(pauseThenMove())).toBe(0);
    expect(mouseDirectionChanges(straightToTarget())).toBe(0);
  });

  it("L5 Suavidad del giro: arco humano = 1; esquinas duras de bot = 0", () => {
    // Dirección de scoring: 1 = humano (HUMAN_SIGNALS). Un solo sobrepaso
    // produce un giro de 180° y deprime esta medida; se documenta aquí.
    const smooth = mouseTurnSmoothness(smoothArc());
    const hard = mouseTurnSmoothness(hardCorners());
    unit(smooth);
    unit(hard);
    expect(smooth).toBeGreaterThan(0.9);
    expect(hard).toBeLessThan(0.1);
  });

  it("L6 Teletransporte: salto de 700px en 8ms = 1; Fitts humano = 0; zoom invariante", () => {
    const bot = mouseTeleport(teleportBot());
    const human = mouseTeleport(humanFittsBell());
    unit(bot);
    unit(human);
    expect(bot).toBeCloseTo(1, 6);
    expect(human).toBe(0);
    expect(mouseTeleport(zoom(teleportBot(), 4))).toBe(bot);
  });

  it("L7 Saltos grandes: bot = 1; humano = 0; ráfaga coalescida dt=0 = 0 (fix)", () => {
    expect(mouseLargeJumps(teleportBot())).toBeCloseTo(1, 6);
    expect(mouseLargeJumps(humanFittsBell())).toBe(0);
    // Antes los micro-pasos con dt=0 deprimían la mediana y marcaban salto.
    expect(mouseLargeJumps(zeroDtBurst())).toBe(0);
    unit(mouseLargeJumps(zeroDtBurst()));
  });

  it("L8 Eficiencia del camino: ida y vuelta = 0; recorrido directo = 1", () => {
    const roundTrip = from([
      [0, 0, 0],
      [100, 0, 10],
      [0, 0, 20],
    ]);
    expect(mouseStraightness(roundTrip)).toBe(0);
    expect(mouseStraightness(straightToTarget())).toBe(1);
  });

  it("L9 Zigzag: alternancia lateral alta; temblor humano ≈ 0; invariante al zoom (fix)", () => {
    const zig = from([
      [0, 0, 0],
      [10, 5, 10],
      [20, 0, 20],
      [30, 5, 30],
      [40, 0, 40],
    ]);
    expect(mouseZigzag(zig)).toBeGreaterThan(0.9);
    expect(mouseZigzag(zoom(zig, 4))).toBeGreaterThan(0.9);
    // Fix: el suelo era absoluto (0.5px) y el zoom 4x convertía el wobble
    // subpíxel del mismo humano en "zigzag" (0.583 -> 0).
    const h = mouseZigzag(humanFittsBell());
    const h4 = mouseZigzag(zoom(humanFittsBell(), 4));
    unit(h);
    unit(h4);
    expect(h).toBeLessThan(0.1);
    expect(h4).toBe(h);
  });

  it("L10 Simetría: ida/vuelta calcadas = 1; vuelta desigual = 0", () => {
    expect(mouseSymmetry(outAndBack(true))).toBeCloseTo(1, 6);
    expect(mouseSymmetry(outAndBack(false))).toBeLessThan(0.6);
    expect(mouseSymmetry([])).toBe(NEUTRAL);
  });

  it("L11 Repetición exacta: macro repetida = 1; humano variable = 0; un segmento = neutro", () => {
    expect(mouseExactRepetition(exactReplay())).toBeCloseTo(1, 6);
    expect(mouseExactRepetition(variedReplay())).toBe(0);
    expect(mouseExactRepetition(humanFittsBell())).toBe(NEUTRAL);
    expect(mouseExactRepetition([])).toBe(NEUTRAL);
    // Opt-in: no entra en ninguna tabla ni extractor existente.
    expect(Object.keys(MOUSE_PARTIAL_FEATURE_WEIGHTS)).not.toContain("exactRepetition");
    expect(Object.keys(MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS)).not.toContain("exactRepetition");
  });

  it("L12 Curvas matemáticas perfectas: arco constante = alto; curva irregular = bajo", () => {
    expect(mousePerfectCurves(circleBot())).toBeGreaterThan(0.9);
    const irregular = from([
      [100, 0, 0],
      [180, 20, 10],
      [240, 90, 20],
      [250, 180, 30],
      [200, 250, 40],
      [110, 260, 50],
      [40, 200, 60],
      [20, 110, 70],
    ]);
    expect(mousePerfectCurves(irregular)).toBeLessThan(0.5);
    expect(mousePerfectCurves(straightToTarget())).toBe(0);
  });

  it("L13 Direcciones favoritas: pasos en ejes canónicos = 1; ángulo natural = 0", () => {
    expect(mouseFavoriteDirections(straightToTarget())).toBe(1);
    const natural = Array.from({ length: 6 }, (_, i) => p(i * 10, i * 10 * Math.tan(0.31), i * 12));
    expect(mouseFavoriteDirections(natural)).toBe(0);
  });

  it("L14 Origen del movimiento: reaparición de golpe = 1; continuidad = 0", () => {
    const abrupt = [p(0, 0, 0), p(10, 0, 10), p(10, 0, 20, 2), p(1010, 0, 30), p(1020, 0, 40)];
    const gentle = [p(0, 0, 0), p(10, 0, 10), p(10, 0, 20, 2), p(10, 0, 30), p(20, 0, 40)];
    expect(mouseMovementOrigin(abrupt)).toBeCloseTo(1, 6);
    expect(mouseMovementOrigin(gentle)).toBe(0);
    expect(mouseMovementOrigin([])).toBe(NEUTRAL);
  });

  it("L15 Entradas por el borde: entrada natural ≈ 0; aparición de golpe = 1", () => {
    const natural = [
      p(8, 300, 0),
      p(5, 298, 12),
      p(3, 296, 25, 1),
      p(40, 300, 40),
      p(120, 310, 55),
    ];
    const abrupt = [p(8, 300, 0), p(5, 298, 12), p(980, 720, 25, 1), p(990, 725, 40)];
    expect(mouseEdgeEntries(natural)).toBe(0);
    expect(mouseEdgeEntries(abrupt)).toBeCloseTo(1, 6);
    unit(mouseEdgeEntries(natural));
  });

  it("L16 Deriva al pensar: micro-vagabundeo alto; trayecto decidido = 0", () => {
    const drift = from([
      [0, 0, 0],
      [1, 0, 10],
      [1, 0.5, 20],
      [10, 0.5, 30],
      [10, 1, 40],
      [1, 1, 50],
      [1, 1.5, 60],
      [10, 1.5, 70],
      [10, 2, 80],
      [0, 2, 90],
      [0, 0, 100],
    ]);
    expect(mouseThinkingDrift(drift)).toBeGreaterThan(0.5);
    expect(mouseThinkingDrift(straightToTarget())).toBe(0);
    expect(mouseThinkingDrift([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// ⚡ VELOCIDAD Y ACELERACIÓN (L18-L31)
// ---------------------------------------------------------------------------

describe("checklist mouse · velocidad y aceleración (realista)", () => {
  it("L18 Velocidad promedio: flick rápido = 1; movimiento cuidadoso = 0", () => {
    expect(mouseAverageSpeed(fastFlick())).toBeCloseTo(1, 6);
    expect(mouseAverageSpeed(slowCareful())).toBe(0);
    unit(mouseAverageSpeed(humanFittsBell()));
  });

  it("L19 Velocidad máxima: pico de flick = 1; humano cuidadoso = 0", () => {
    expect(mouseMaxSpeed(fastFlick())).toBeCloseTo(1, 6);
    expect(mouseMaxSpeed(slowCareful())).toBe(0);
    unit(mouseMaxSpeed(humanFittsBell()));
  });

  it("L20 Perfil de campana: humano acelera y frena = 0; bot plano = 1", () => {
    expect(mouseBellProfile(humanFittsBell())).toBeLessThan(0.1);
    expect(mouseBellProfile(botLinear())).toBeCloseTo(1, 6);
    unit(mouseBellProfile(humanFittsBell()));
  });

  it("L21 Aceleración inicial: arranque suave humano = 0; arranque instantáneo = 1", () => {
    expect(mouseInitialAcceleration(humanFittsBell())).toBe(0);
    const burst = from([
      [0, 0, 0],
      [100, 0, 10],
      [110, 0, 20],
      [120, 0, 30],
    ]);
    expect(mouseInitialAcceleration(burst)).toBeCloseTo(1, 6);
  });

  it("L22 Frenado final: humano desacelera = 0; bot mantiene ritmo = 1", () => {
    expect(mouseFinalBraking(humanFittsBell())).toBe(0);
    expect(mouseFinalBraking(botLinear())).toBeCloseTo(1, 6);
  });

  it("L23 Velocidad constante: bot 16.67ms = 1; Fitts humano < 0.3", () => {
    expect(mouseSpeedUniformity(botLinear())).toBeCloseTo(1, 6);
    expect(mouseSpeedUniformity(humanFittsBell())).toBeLessThan(0.3);
  });

  it("L24 Cambios bruscos de velocidad (jerk): humano tironeante bajo; bot suave = 1", () => {
    expect(mouseJerk(jitteryHuman())).toBeLessThan(0.5);
    expect(mouseJerk(botLinear())).toBeCloseTo(1, 6);
    unit(mouseJerk(jitteryHuman()));
  });

  it("L25 Variación entre movimientos: bot igual velocidad = 1; humano variable = 0", () => {
    expect(mouseSpeedVariation(segmentsWithSpeeds([2, 2, 2]))).toBeCloseTo(1, 6);
    expect(mouseSpeedVariation(segmentsWithSpeeds([0.2, 1, 6]))).toBe(0);
    expect(mouseSpeedVariation([])).toBe(NEUTRAL);
  });

  it("L26 Velocidad según distancia: lejos más rápido = 0; bot a ritmo fijo = 1", () => {
    const human = [
      p(0, 0, 0),
      p(10, 0, 100),
      p(10, 0, 101, 2),
      p(10, 0, 101),
      p(110, 0, 180),
      p(110, 0, 181, 2),
      p(110, 0, 181),
      p(1110, 0, 300),
    ];
    const bot = [
      p(0, 0, 0),
      p(10, 0, 10),
      p(10, 0, 11, 2),
      p(10, 0, 11),
      p(110, 0, 111),
      p(110, 0, 112, 2),
      p(110, 0, 112),
      p(1110, 0, 1112),
    ];
    expect(mouseSpeedByDistance(human)).toBe(0);
    expect(mouseSpeedByDistance(bot)).toBeCloseTo(1, 6);
  });

  it("L27 Velocidad imposible: salto de 700px/8ms = 1; humano < 0.4", () => {
    expect(mouseImpossibleSpeed(teleportBot())).toBeCloseTo(1, 6);
    expect(mouseImpossibleSpeed(humanFittsBell())).toBeLessThan(0.4);
    expect(mouseImpossibleSpeed(slowCareful())).toBe(0);
  });

  it("L28 Pausas durante el trayecto: humano pausa < 0.6; bot sin pausas = 1", () => {
    expect(mouseMicroPauses(humanWithPauses())).toBeLessThan(0.6);
    expect(mouseMicroPauses(botLinear())).toBeCloseTo(1, 6);
    unit(mouseMicroPauses(humanWithPauses()));
  });

  it("L29 Tiempo parado antes de moverse: espera fija larga = 1; ritmo irregular = 0", () => {
    expect(mouseStillBeforeMove(longWait())).toBeCloseTo(1, 6);
    expect(mouseStillBeforeMove(irregularWait())).toBe(0);
    unit(mouseStillBeforeMove(longWait()));
  });

  it("L30 Ritmo de eventos: 60Hz y 120Hz regulares = 1; humano irregular = 0", () => {
    expect(mouseIntervalRegularity(regularCadence(1000 / 60))).toBeCloseTo(1, 6);
    expect(mouseIntervalRegularity(regularCadence(1000 / 120))).toBeCloseTo(1, 6);
    expect(mouseIntervalRegularity(irregularCadence())).toBeLessThan(0.3);
  });

  it("L31 Resolución temporal: ms enteros = 1; tiempo fraccionario/coalescido = 0", () => {
    expect(mouseTemporalResolution(regularCadence(16, true))).toBeCloseTo(1, 6);
    expect(mouseTemporalResolution(regularCadence(16.67))).toBe(0);
    expect(mouseTemporalResolution(irregularCadence())).toBe(0);
    unit(mouseTemporalResolution(zeroDtBurst()));
  });
});

// ---------------------------------------------------------------------------
// 🤏 TEMBLOR Y DETALLES FINOS (L33-L39)
// ---------------------------------------------------------------------------

describe("checklist mouse · temblor y detalles finos (realista)", () => {
  it("L33 Micro-temblor de la mano: temblor perpendicular bajo; trazo limpio = 1", () => {
    const human = mouseTremor(tremorHuman());
    const bot = mouseTremor(tremorBot());
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.7);
    expect(bot).toBeCloseTo(1, 6);
  });

  it("L34 Ruido en los píxeles: desviaciones alternas < trazo exacto (misma medida)", () => {
    const noisy = mouseTremor(tremorHuman());
    const clean = mouseTremor(tremorBot());
    expect(noisy).toBeLessThan(clean);
    expect(clean - noisy).toBeGreaterThan(0.2);
  });

  it("L35 Movimientos subpíxel: coords fraccionarias humanas = 0; bot entero = 1", () => {
    expect(mouseSubpixel(humanFittsBell())).toBe(0);
    expect(mouseSubpixel(botLinear())).toBeCloseTo(1, 6);
    expect(mouseSubpixel([])).toBe(NEUTRAL);
  });

  it("L36 Tipo de dispositivo: mouse=0, pen=1/3, touch=2/3, mixto, hostil acotado", () => {
    expect(mouseDeviceType([p(0, 0, 0, 0, 0)])).toBe(0);
    expect(mouseDeviceType([p(0, 0, 0, 0, 1)])).toBeCloseTo(1 / 3, 6);
    expect(mouseDeviceType([p(0, 0, 0, 0, 2)])).toBeCloseTo(2 / 3, 6);
    const mixed = mouseDeviceType([p(0, 0, 0, 0, 0), p(0, 0, 1, 0, 2)]);
    expect(mixed).toBeCloseTo(1 / 3, 6);
    const hostile = mouseDeviceType([{ ...p(0, 0, 0), pointerType: 99 }]);
    unit(hostile);
  });

  it("L37 Pasos enteros: bot = 1; coords fraccionarias humanas = 0", () => {
    expect(mouseRoundSteps(botLinear())).toBeCloseTo(1, 6);
    expect(mouseRoundSteps(humanFittsBell())).toBe(0);
    unit(mouseRoundSteps(zeroDtBurst()));
  });

  it("L38 Estabilidad del cursor quieto: bot clavado = 1; humano nunca inmóvil = 0", () => {
    expect(mouseRestStability(frozen())).toBeCloseTo(1, 6);
    expect(mouseRestStability(microDrift())).toBe(0);
    expect(mouseRestStability([])).toBe(NEUTRAL);
  });

  it("L39 Deriva al soltar: micro-movimiento tras reposo = 1; reanudación amplia = 0", () => {
    // Dirección documentada: deriva = avance posterior / paso previo;
    // deriva <= 0.05 -> 1, >= 0.3 -> 0 (ver final-pointer-measures.test.ts).
    const micro = from([
      [0, 0, 0],
      [100, 0, 10],
      [100, 0, 20],
      [100, 0, 30],
      [100.1, 0, 40],
      [100.2, 0, 50],
    ]);
    const resumed = from([
      [0, 0, 0],
      [100, 0, 10],
      [100, 0, 20],
      [100, 0, 30],
      [180, 0, 40],
      [270, 0, 50],
    ]);
    expect(mouseDriftAfterRelease(micro)).toBeCloseTo(1, 6);
    expect(mouseDriftAfterRelease(resumed)).toBe(0);
    expect(mouseDriftAfterRelease([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// 🎯 PUNTERÍA (L41-L52)
// ---------------------------------------------------------------------------

describe("checklist mouse · puntería (realista, con clicks)", () => {
  const humanAims = aims(true);
  const botAims = aims(false);
  const earlyAims = aims(false, false, 960);
  const detourAims = aims(true, true);
  const humanHover = hovers(true);
  const botHover = hovers(false);

  it("L41 Ley de Fitts: tiempo crece con distancia = 0; tiempo fijo = 1", () => {
    expect(mouseFittsLaw(humanAims.pointer, humanAims.clicks)).toBe(0);
    expect(mouseFittsLaw(botAims.pointer, botAims.clicks)).toBeCloseTo(1, 6);
    expect(mouseFittsLaw([])).toBe(NEUTRAL);
    expect(mouseFittsLaw(humanAims.pointer)).toBe(NEUTRAL);
  });

  it("L42 Sobrepaso: corrección humana proporcional (no binaria) = 0.165; bot = 0 (fix)", () => {
    const human = mouseOvershoot(humanFittsBell());
    unit(human);
    // Antes: CUALQUIER reversión daba exactamente 1. Ahora mide el retroceso real.
    expect(human).toBeGreaterThan(0.05);
    expect(human).toBeLessThan(0.6);
    expect(mouseOvershoot(botLinear())).toBe(0);
    expect(mouseOvershoot(zoom(humanFittsBell(), 4))).toBe(human);
  });

  it("L43 Corrección fina: micro-ajustes al llegar = 0; bot directo = 1", () => {
    expect(mouseFineCorrection(humanFittsBell())).toBe(0);
    expect(mouseFineCorrection(botLinear())).toBeCloseTo(1, 6);
    unit(mouseFineCorrection(humanFittsBell()));
  });

  it("L44 Tiempo de apuntar: tiempos variables humanos < 0.5; bot fijo = 1", () => {
    expect(mouseAimTime(humanAims.pointer, humanAims.clicks)).toBeLessThan(0.5);
    expect(mouseAimTime(botAims.pointer, botAims.clicks)).toBeCloseTo(1, 6);
    expect(mouseAimTime([])).toBe(NEUTRAL);
  });

  it("L45 Tiempo hasta el click: pausa humana < 0.4; click instantáneo = 1", () => {
    expect(mouseTimeToClick(humanAims.pointer, humanAims.clicks)).toBeLessThan(0.4);
    expect(mouseTimeToClick(botAims.pointer, botAims.clicks)).toBeCloseTo(1, 6);
    expect(mouseTimeToClick([])).toBe(NEUTRAL);
  });

  it("L46 Precisión del click: humano disperso = 0; bot siempre en el centro = 1", () => {
    expect(mouseClickPrecision(humanAims.pointer)).toBe(0);
    expect(mouseClickPrecision(botAims.pointer)).toBeCloseTo(1, 6);
    expect(mouseClickPrecision([])).toBe(NEUTRAL);
  });

  it("L47 Distribución de dónde clickea: dispersión dentro del botón < centro exacto", () => {
    const spread = mouseClickPrecision(humanAims.pointer);
    const center = mouseClickPrecision(botAims.pointer);
    expect(spread).toBeLessThan(center);
    expect(center - spread).toBeGreaterThan(0.5);
  });

  it("L48 Fallos de puntería y corrección: humano corrige = 0; bot directo = 1", () => {
    expect(mouseCorrectedMisses(humanFittsBell())).toBe(0);
    expect(mouseCorrectedMisses(botLinear())).toBeCloseTo(1, 6);
    expect(mouseCorrectedMisses([])).toBe(NEUTRAL);
  });

  it("L49 Ruta hacia el objetivo: rodeo < 0.8; ruta recta del bot = 1", () => {
    const human = mouseRouteToTarget(detourAims.pointer, detourAims.clicks);
    const bot = mouseRouteToTarget(botAims.pointer, botAims.clicks);
    unit(human);
    expect(human).toBeLessThan(0.8);
    expect(bot).toBeCloseTo(1, 6);
  });

  it("L50 Anticipación: cursor esperando = 1; humano clickea al llegar = 0", () => {
    expect(mouseAnticipation(earlyAims.pointer, earlyAims.clicks)).toBeCloseTo(1, 6);
    expect(mouseAnticipation(humanAims.pointer, humanAims.clicks)).toBe(0);
    expect(mouseAnticipation([])).toBe(NEUTRAL);
  });

  it("L51 Hover antes de clickear: bot sin hover = 1; humano inspecciona < 0.2", () => {
    expect(mouseHoverBeforeClick(botAims.pointer, botAims.clicks)).toBeCloseTo(1, 6);
    expect(mouseHoverBeforeClick(humanAims.pointer, humanAims.clicks)).toBeLessThan(0.2);
    expect(mouseHoverBeforeClick([])).toBe(NEUTRAL);
  });

  it("L52 Hover sobre irrelevantes: bot solo reposa donde clickea = 1; humano < bot", () => {
    const bot = mouseHoverIrrelevant(botHover.pointer, botHover.clicks);
    const human = mouseHoverIrrelevant(humanHover.pointer, humanHover.clicks);
    expect(bot).toBeCloseTo(1, 6);
    expect(human).toBeLessThan(bot);
    unit(human);
    expect(mouseHoverIrrelevant([])).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// Edge cases reales de navegación + invariancia de calibración
// ---------------------------------------------------------------------------

describe("checklist mouse · edge cases reales", () => {
  it("pointerenter/leave: las fronteras duras NUNCA unen segmentos", () => {
    const samples = [
      p(0, 0, 0),
      p(10, 0, 10),
      p(20, 0, 20),
      p(20, 0, 30, 1),
      p(900, 700, 40),
      p(910, 700, 50),
      p(920, 700, 60),
    ];
    expect(mouseTeleport(samples)).toBe(0);
    expect(mouseLargeJumps(samples)).toBe(0);
    expect(mouseStraightness(samples)).toBeCloseTo(1, 6);
  });

  it("coalesced timestamps: ráfaga dt=0 no crea saltos ni valores no finitos", () => {
    const burst = zeroDtBurst();
    expect(mouseLargeJumps(burst)).toBe(0);
    for (const f of [
      mouseTeleport,
      mouseJerk,
      mouseSpeedUniformity,
      mouseIntervalRegularity,
      mouseOvershoot,
    ]) {
      unit(f(burst));
    }
  });

  it("sub-pixel noise: pausa con jitter no puntúa como curvatura/giro (fix)", () => {
    expect(mouseCurvature(pauseThenMove())).toBe(0);
    expect(mouseDirectionChanges(pauseThenMove())).toBe(0);
    expect(mouseTremor(tremorHuman())).toBeLessThan(mouseTremor(tremorBot()));
  });

  it("120Hz vs 60Hz: ambos cadenciosos; el jitter humano rompe la regularidad", () => {
    expect(mouseIntervalRegularity(regularCadence(1000 / 60))).toBeCloseTo(1, 6);
    expect(mouseIntervalRegularity(regularCadence(1000 / 120))).toBeCloseTo(1, 6);
    expect(mouseIntervalRegularity(irregularCadence())).toBeLessThan(0.3);
  });

  it("zoom gigante (4x): zigzag, teletransporte y sobrepaso son invariantes de escala", () => {
    const human = humanFittsBell();
    expect(mouseZigzag(zoom(human, 4))).toBe(mouseZigzag(human));
    expect(mouseTeleport(zoom(human, 4))).toBe(mouseTeleport(human));
    expect(mouseOvershoot(zoom(human, 4))).toBe(mouseOvershoot(human));
  });

  it("ráfaga dt=0 al inicio: ninguna medida devuelve NaN/Infinity", () => {
    const burst = [p(5, 5, 0), p(5.1, 5.1, 0), p(5.2, 5.2, 0), p(6, 6, 16), p(20, 19, 32)];
    const measures = extractMouseFeatures(burst);
    for (const value of Object.values(measures)) unit(value);
  });

  it("todos los extractores devuelven valores finitos en [0,1] para escenarios reales", () => {
    const { pointer, clicks } = aims(true);
    const sets = [
      extractMouseFeatures(pointer),
      extractPartialMouseFeatures(pointer),
      extractFinalMouseFeatures(pointer, clicks),
    ];
    for (const set of sets) for (const value of Object.values(set)) unit(value);
    unit(mouseExactRepetition(exactReplay()));
  });

  it("medidas nuevas siguen siendo opt-in / peso 0", () => {
    for (const weight of Object.values(MOUSE_PARTIAL_FEATURE_WEIGHTS)) expect(weight).toBe(0);
    for (const weight of Object.values(MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS)) expect(weight).toBe(0);
    expect(Object.isFrozen(MOUSE_PARTIAL_FEATURE_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(MOUSE_FINAL_PARTIAL_FEATURE_WEIGHTS)).toBe(true);
  });
});
