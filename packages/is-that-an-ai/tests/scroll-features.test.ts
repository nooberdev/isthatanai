import { describe, expect, it } from "bun:test";
import type { ScrollSample } from "../src/index";
import { computeScrollScore, extractScrollFeatures, SCROLL_NEUTRAL } from "../src/index";

function scrolls(dx: number[], dy: number[], t: number[]): ScrollSample[] {
  return dx.map((x, i) => ({
    seq: i + 1,
    dx: x,
    dy: dy[i],
    t: t[i],
    trusted: 1,
    source: 0,
  }));
}

/** Bot: delta redondo, eje fijo, ritmo e inercia ausentes, dirección única. */
function botScroll(): ScrollSample[] {
  return scrolls(
    Array(12).fill(0),
    Array(12).fill(100),
    Array.from({ length: 12 }, (_, i) => i * 60),
  );
}

/** Humano: ruido en el delta, pausas, reversiones, desaceleración y deriva lateral. */
const HUMAN_INTERVALS = [20, 90, 35, 240, 60, 270, 45, 220, 80, 250, 70];
const HUMAN_MAGNITUDES = [123.7, 94.2, 71.3, 46.8, 27.5, 13.4, 88.6, 32.1, 63.7, 29.4, 44.8, 17.2];

function humanScroll(): ScrollSample[] {
  const times = [0];
  for (const dt of HUMAN_INTERVALS) times.push(times[times.length - 1] + dt);
  const dy = HUMAN_MAGNITUDES.map((m, i) => (i % 2 === 0 ? m : -m));
  const dx = HUMAN_MAGNITUDES.map((m, i) => (i % 2 === 0 ? 0.3 * m : -0.3 * m));
  return scrolls(dx, dy, times);
}

describe("extractScrollFeatures", () => {
  it("devuelve 7 medidas en [0,1] y neutros sin evidencia", () => {
    const features = extractScrollFeatures(botScroll());
    expect(Object.keys(features)).toHaveLength(7);
    for (const value of Object.values(features)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of Object.values(extractScrollFeatures([]))) {
      expect(value).toBe(SCROLL_NEUTRAL);
    }
  });

  it("secuencia de bot: todas las medidas altas", () => {
    const features = extractScrollFeatures(botScroll());
    expect(computeScrollScore(features)).toBeGreaterThan(0.9);
    expect(features.deltaUniformity).toBeGreaterThan(0.9);
    expect(features.intervalRegularity).toBeGreaterThan(0.9);
    expect(features.directionChanges).toBeGreaterThan(0.9);
    expect(features.decelerationProfile).toBeGreaterThan(0.9);
    expect(features.noPauses).toBeGreaterThan(0.9);
    expect(features.roundDeltas).toBeGreaterThan(0.9);
    expect(features.axisLock).toBeGreaterThan(0.9);
  });

  it("secuencia humana: valores opuestos (ruido, pausas, reversión, inercia)", () => {
    const bot = extractScrollFeatures(botScroll());
    const human = extractScrollFeatures(humanScroll());
    expect(computeScrollScore(bot)).toBeGreaterThan(computeScrollScore(human) + 0.5);
    expect(human.deltaUniformity).toBeLessThan(bot.deltaUniformity - 0.4);
    expect(human.intervalRegularity).toBeLessThan(0.2);
    expect(human.directionChanges).toBeLessThan(0.1);
    expect(human.decelerationProfile).toBeLessThan(0.1);
    expect(human.noPauses).toBeLessThan(0.1);
    expect(human.roundDeltas).toBeLessThan(0.1);
    expect(human.axisLock).toBeLessThan(bot.axisLock - 0.5);
  });

  it("scroll real del documento (source=1) produce score de scroll", () => {
    const realScroll = botScroll().map((sample) => ({
      ...sample,
      seq: sample.seq + 100,
      t: sample.t + 30,
      source: 1 as const,
    }));
    expect(realScroll.every((sample) => sample.source === 1)).toBe(true);
    expect(computeScrollScore(extractScrollFeatures(realScroll))).toBeGreaterThan(0.9);
    expect(extractScrollFeatures(realScroll)).toEqual(extractScrollFeatures(botScroll()));
  });

  it("conviven wheel y scroll real: se usan SOLO las de source=1 (sin doble conteo)", () => {
    const wheel = botScroll();
    // Mismo gesto visto por ambas fuentes en una ventana corta (30ms).
    const real = wheel.map((sample) => ({
      ...sample,
      seq: sample.seq + 100,
      t: sample.t + 30,
      source: 1 as const,
    }));
    const interleaved = [...wheel, ...real].sort((a, b) => a.t - b.t);
    const onlyReal = extractScrollFeatures(real);
    expect(extractScrollFeatures(interleaved)).toEqual(onlyReal);
    expect(computeScrollScore(extractScrollFeatures(interleaved))).toBe(
      computeScrollScore(onlyReal),
    );
  });
});
