import { describe, expect, it } from "bun:test";
import {
  countSegments,
  extractMouseFeatures,
  mouseIntervalRegularity,
  mouseJerk,
  mouseMicroPauses,
  mouseOvershoot,
  mouseRoundSteps,
  mouseSpeedUniformity,
  mouseStraightness,
  mouseTeleport,
  mouseTremor,
  mouseTurnSmoothness,
  NEUTRAL,
} from "../src/features/mouse";
import type { PointerSample } from "../src/types";

interface RawPoint {
  x: number;
  y: number;
  t: number;
  kind?: 0 | 1 | 2;
}

function points(raw: RawPoint[]): PointerSample[] {
  return raw.map((p, i) => ({
    seq: i + 1,
    x: p.x,
    y: p.y,
    t: p.t,
    kind: p.kind ?? 0,
    pointerType: 0,
    trusted: 1,
  }));
}

/** Camino recto: n pasos de (dx, dy) cada dt ms. */
function line(dx: number, dy: number, count: number, dt = 10, t0 = 0): PointerSample[] {
  return points(
    Array.from({ length: count }, (_, i) => ({ x: i * dx, y: i * dy, t: t0 + i * dt })),
  );
}

describe("countSegments", () => {
  it("cuenta un segmento por run de kind 0", () => {
    expect(countSegments(line(10, 0, 5))).toBe(1);
  });

  it("kind 1|2 separa segmentos sin unirlos", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20, kind: 1 },
      { x: 100, y: 0, t: 30 },
      { x: 110, y: 0, t: 40 },
      { x: 50, y: 0, t: 50, kind: 2 },
    ]);
    expect(countSegments(samples)).toBe(2);
  });
});

describe("extractMouseFeatures", () => {
  it("devuelve los 10 campos en [0, 1]", () => {
    const features = extractMouseFeatures(line(10, 0, 10));
    expect(Object.keys(features)).toEqual([
      "straightness",
      "teleport",
      "speedUniformity",
      "jerk",
      "tremor",
      "intervalRegularity",
      "overshoot",
      "turnSmoothness",
      "microPauses",
      "roundSteps",
    ]);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("sin datos devuelve neutros (0.5), no extremos", () => {
    const features = extractMouseFeatures([]);
    expect(Object.values(features).every((v) => v === NEUTRAL)).toBe(true);
  });
});

describe("mouseStraightness (eficiencia del camino)", () => {
  it("camino perfectamente recto -> 1", () => {
    expect(mouseStraightness(line(10, 0, 10))).toBe(1);
    expect(mouseStraightness(line(7, 3, 10))).toBe(1);
  });

  it("camino que vuelve atrás -> 0", () => {
    // displacement 0, path 200 -> efficiency 0 -> linear(0, 0.55, 0.95) = 0
    expect(
      mouseStraightness(
        points([
          { x: 0, y: 0, t: 0 },
          { x: 100, y: 0, t: 10 },
          { x: 0, y: 0, t: 20 },
        ]),
      ),
    ).toBe(0);
  });

  it("sin datos -> neutro", () => {
    expect(mouseStraightness([])).toBe(NEUTRAL);
  });
});

describe("mouseTeleport", () => {
  it("pasos pequeños y uniformes -> 0", () => {
    // steps [10, 10, ...]: medDist=10 -> d/medDist = 1 < 7 -> 0 saltos.
    expect(mouseTeleport(line(10, 0, 6))).toBe(0);
  });

  it("teletransporte detectado -> 1", () => {
    // steps [200, 1, 1]: medDist=1 (ratio 200), medSpeed=0.1 (ratio 200).
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 200, y: 0, t: 10 },
      { x: 201, y: 0, t: 20 },
      { x: 202, y: 0, t: 30 },
    ]);
    expect(mouseTeleport(samples)).toBe(1);
  });

  it("saltos grandes pero continuos no cuentan (todos escalan igual)", () => {
    // steps d=50px uniformes: medDist=50 -> ratio 1 < 7 -> 0 saltos.
    expect(mouseTeleport(line(50, 0, 6, 20))).toBe(0);
  });

  it("no une segmentos a través de kind 1|2", () => {
    // Segmento 1: pasos de 10; kind 1; segmento 2: pasos de 10.
    // Si se unieran, el salto sería enorme y teleport > 0; sin unión, 0.
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20, kind: 1 },
      { x: 100, y: 0, t: 30 },
      { x: 110, y: 0, t: 40 },
    ]);
    expect(mouseTeleport(samples)).toBe(0);
  });

  it("zoom bajo: pasos uniformes de 80px en 5ms -> teleport bajo", () => {
    // Antes d=80>40 y v=16>4 marcaba cada paso como salto. Ahora medDist=80
    // y todos los pasos tienen ratio 1 -> 0 saltos.
    expect(mouseTeleport(line(80, 0, 20, 5))).toBe(0);
  });

  it("invarianza de escala: x0.5 y x2 dan el mismo valor", () => {
    const base: RawPoint[] = [
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 320, y: 0, t: 25 }, // salto de 300px en 5ms
      { x: 330, y: 0, t: 35 },
      { x: 340, y: 0, t: 45 },
    ];
    const scaled = (s: number): PointerSample[] =>
      points(base.map((p) => ({ ...p, x: p.x * s, y: p.y * s })));

    const original = mouseTeleport(scaled(1));
    expect(original).toBeGreaterThan(0.5); // el salto real sí se detecta
    expect(mouseTeleport(scaled(0.5))).toBe(original);
    expect(mouseTeleport(scaled(2))).toBe(original);
  });

  it("salto de 300px entre pasos de 10px sigue detectándose", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 320, y: 0, t: 30 },
      { x: 330, y: 0, t: 40 },
      { x: 340, y: 0, t: 50 },
    ]);
    expect(mouseTeleport(samples)).toBe(1);
  });

  it("distancia grande pero velocidad relativa normal no cuenta (condición AND)", () => {
    // d=300 >> medDist, pero dt=1000 -> v=0.3 < 4 x medSpeed(=1).
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 320, y: 0, t: 1020 },
      { x: 330, y: 0, t: 1030 },
      { x: 340, y: 0, t: 1040 },
    ]);
    expect(mouseTeleport(samples)).toBe(0);
  });
});

describe("mouseSpeedUniformity", () => {
  it("velocidad constante -> 1", () => {
    expect(mouseSpeedUniformity(line(10, 0, 10, 10))).toBe(1);
  });

  it("velocidad variable -> 0", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 200, y: 0, t: 21 },
    ]);
    expect(mouseSpeedUniformity(samples)).toBe(0);
  });
});

describe("mouseJerk", () => {
  it("aceleración constante (velocidad constante) -> 1", () => {
    expect(mouseJerk(line(10, 0, 10, 10))).toBe(1);
  });

  it("aceleración variables -> menor puntaje", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 25, y: 0, t: 20 },
      { x: 35, y: 0, t: 30 },
      { x: 45, y: 0, t: 40 },
    ]);
    const value = mouseJerk(samples);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe("mouseTremor", () => {
  it("trazo limpio -> 1 (poco temblor de mano = IA)", () => {
    expect(mouseTremor(line(10, 0, 10))).toBe(1);
  });

  it("línea recta con pasos alternos 3px/13px -> tremor = 1", () => {
    const pts: RawPoint[] = [];
    let x = 0;
    const offsets = [3, 13];
    for (let i = 0; i < 12; i += 1) {
      x += offsets[i % 2];
      pts.push({ x, y: 0, t: i * 10 });
    }
    expect(mouseTremor(points(pts))).toBe(1);
  });

  it("línea con desviación perpendicular alterna -> tremor bajo", () => {
    const value = mouseTremor(
      points([
        { x: 0, y: 0, t: 0 },
        { x: 10, y: 2, t: 10 },
        { x: 20, y: 0, t: 20 },
        { x: 30, y: 2, t: 30 },
        { x: 40, y: 0, t: 40 },
      ]),
    );
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.5);
  });
});

describe("mouseIntervalRegularity", () => {
  it("intervalos constantes -> 1", () => {
    expect(mouseIntervalRegularity(line(10, 0, 10, 20))).toBe(1);
  });

  it("intervalos irregulares -> 0", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 100 },
      { x: 30, y: 0, t: 101 },
    ]);
    expect(mouseIntervalRegularity(samples)).toBe(0);
  });
});

describe("mouseOvershoot", () => {
  it("sin reversión -> 0", () => {
    expect(mouseOvershoot(line(10, 0, 6))).toBe(0);
  });

  it("reversión detectada -> 0 < score <= 1", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 50, y: 0, t: 10 },
      { x: 100, y: 0, t: 20 },
      { x: 0, y: 0, t: 30 },
      { x: 0, y: 50, t: 40 },
    ]);
    const value = mouseOvershoot(samples);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe("mouseTurnSmoothness", () => {
  it("sin giros -> 1", () => {
    expect(mouseTurnSmoothness(line(10, 0, 6))).toBe(1);
  });

  it("giros bruscos -> menor puntaje", () => {
    const value = mouseTurnSmoothness(
      points([
        { x: 0, y: 0, t: 0 },
        { x: 100, y: 0, t: 10 },
        { x: 200, y: 300, t: 20 },
      ]),
    );
    expect(value).toBeGreaterThan(0.1);
    expect(value).toBeLessThan(0.4);
  });
});

describe("mouseMicroPauses", () => {
  it("sin pausas pequeñas -> 1", () => {
    expect(mouseMicroPauses(line(10, 0, 10))).toBe(1);
  });

  it("con pausas -> menor puntaje", () => {
    const samples = points([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 10 },
      { x: 20, y: 0, t: 20 },
      { x: 30, y: 0, t: 30 },
      { x: 40, y: 0, t: 100 },
      { x: 50, y: 0, t: 110 },
      { x: 60, y: 0, t: 120 },
      { x: 70, y: 0, t: 130 },
    ]);
    const value = mouseMicroPauses(samples);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe("mouseRoundSteps", () => {
  it("pasos enteros -> 1", () => {
    expect(mouseRoundSteps(line(10, 0, 10))).toBe(1);
  });

  it("pasos decimales -> 0", () => {
    expect(mouseRoundSteps(line(10.5, 0, 10))).toBe(0);
  });
});
