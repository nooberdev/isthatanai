import { describe, expect, it } from "bun:test";
import type { ClickSample } from "../src/index";
import { CLICK_NEUTRAL, computeClickScore, extractClickFeatures } from "../src/index";

interface PairSpec {
  x: number;
  y: number;
  downT: number;
  upT: number;
  button?: number;
  drift?: number;
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
      x: pair.x + (pair.drift ?? 0),
      y: pair.y,
      t: pair.upT,
      kind: 1,
      button,
      trusted: 1,
    });
  }
  return out;
}

/** Bot: misma puntería, duración fija, ritmo fijo, sin deriva ni botones. */
function botClicks(): ClickSample[] {
  return clicks(
    Array.from({ length: 8 }, (_, i) => ({
      x: 500.5,
      y: 300.25,
      downT: i * 100,
      upT: i * 100 + 60,
    })),
  );
}

/** Humano: duraciones/pausas/ruido variables, deriva, botones y puntos distintos. */
const HUMAN_DURATIONS = [30, 220, 55, 260, 40, 190, 70, 240];
const HUMAN_INTERVALS = [200, 150, 1600, 180, 1700, 220, 1500];
const HUMAN_DRIFT = [12, 15, 9, 18, 20, 11, 16, 14];

function humanClicks(): ClickSample[] {
  let t = 0;
  const pairs: PairSpec[] = [];
  for (let i = 0; i < 8; i += 1) {
    pairs.push({
      x: 100 + i * 90 + (i % 3) * 0.37,
      y: 50 + (i % 4) * 80 + 0.25,
      downT: t,
      upT: t + HUMAN_DURATIONS[i],
      drift: HUMAN_DRIFT[i],
    });
    t += HUMAN_INTERVALS[i] ?? 200;
  }
  return clicks(pairs);
}

describe("extractClickFeatures", () => {
  it("devuelve 7 medidas en [0,1] y neutros sin evidencia", () => {
    const features = extractClickFeatures(botClicks());
    expect(Object.keys(features)).toHaveLength(7);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of Object.values(extractClickFeatures([]))) {
      expect(value).toBe(CLICK_NEUTRAL);
    }
  });

  it("secuencia de bot: todas las medidas altas", () => {
    const features = extractClickFeatures(botClicks());
    expect(computeClickScore(features)).toBeGreaterThan(0.9);
    expect(features.durationRegularity).toBeGreaterThan(0.9);
    expect(features.intervalRegularity).toBeGreaterThan(0.9);
    expect(features.burstiness).toBeGreaterThan(0.9);
    expect(features.downUpDrift).toBeGreaterThan(0.9);
    expect(features.singleButton).toBe(1);
    expect(features.noPauses).toBeGreaterThan(0.9);
    expect(features.aimConsistency).toBeGreaterThan(0.9);
  });

  it("secuencia humana: valores opuestos (ruido, pausas, deriva, puntos distintos)", () => {
    const bot = extractClickFeatures(botClicks());
    const human = extractClickFeatures(humanClicks());
    expect(computeClickScore(bot)).toBeGreaterThan(computeClickScore(human) + 0.5);
    expect(human.durationRegularity).toBeLessThan(bot.durationRegularity - 0.5);
    expect(human.intervalRegularity).toBeLessThan(bot.intervalRegularity - 0.5);
    expect(human.burstiness).toBeLessThan(0.1);
    expect(human.downUpDrift).toBeLessThan(0.1);
    expect(human.singleButton).toBe(1);
    expect(human.noPauses).toBeLessThan(0.1);
    expect(human.aimConsistency).toBeLessThan(bot.aimConsistency - 0.5);
  });

  it("un clic medio de 3000 ms no cambia el score de clic", () => {
    const base = botClicks();
    const baseScore = computeClickScore(extractClickFeatures(base));
    const middleDown: ClickSample = {
      seq: base.length + 1,
      x: 12.5,
      y: 34.75,
      t: 2000,
      kind: 0,
      button: 1,
      trusted: 1,
    };
    const middleUp: ClickSample = {
      seq: base.length + 2,
      x: 900.25,
      y: 800.5,
      t: 5000,
      kind: 1,
      button: 1,
      trusted: 1,
    };
    expect(middleUp.t - middleDown.t).toBe(3000);
    expect(computeClickScore(extractClickFeatures([...base, middleDown, middleUp]))).toBe(
      baseScore,
    );
    // Solo botón medio: sin evidencia de botón principal -> neutro.
    expect(computeClickScore(extractClickFeatures([middleDown, middleUp]))).toBe(CLICK_NEUTRAL);
  });
});
