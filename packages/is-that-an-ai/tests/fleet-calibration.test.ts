import { describe, expect, it } from "bun:test";
import type { ScrollSample } from "../src/index";
import {
  AI_MIN,
  extractScrollFeatures,
  IsThatAnAI,
  ScoreComputer,
  withoutAutoscroll,
} from "../src/index";

const SCROLL_EVIDENCE = 8;

function wheelBot(dtMs: number, count = 20): ScrollSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: 100,
    t: i * dtMs,
    trusted: 1,
    source: 0,
  }));
}

/** `scrollTo`/PageDown del bot: saltos grandes y cadencia lenta (source=1). */
function jumpBot(jump: number, dtMs: number, count = 10): ScrollSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: jump,
    t: i * dtMs,
    trusted: 1,
    source: 1,
  }));
}

function makeRand(initial: number): () => number {
  let seed = initial;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

/** Bot humanizado / anti-detector: jitter, pausas y reversiones. */
function jitterBot(
  intervals: number[],
  seed: number,
  minDelta: number,
  span: number,
  flip: (i: number) => boolean,
): ScrollSample[] {
  const rand = makeRand(seed);
  const out: ScrollSample[] = [];
  let t = 0;
  for (let i = 0; i <= intervals.length; i += 1) {
    const delta = minDelta + Math.floor(rand() * span);
    out.push({ seq: i + 1, dx: 0, dy: flip(i) ? -delta : delta, t, trusted: 1, source: 0 });
    t += intervals[i] ?? 60;
  }
  return out;
}

const HUMANIZADO = jitterBot(
  [20, 90, 35, 240, 60, 270, 45, 220, 80, 250, 70, 200, 50, 260, 85],
  777,
  80,
  41,
  (i) => i % 2 === 1,
);
const ANTIDETECTOR = jitterBot(
  [25, 150, 40, 260, 55, 230, 90, 280, 35, 190, 75, 240, 45, 270, 60],
  4242,
  60,
  141,
  (i) => i % 3 === 2,
);

/** Autoscroll humano con botón medio: source=1, ~40px, ~16ms por frame. */
function humanAutoscroll(count = 40): ScrollSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: 35 + (i % 5),
    t: 5000 + i * 16,
    trusted: 1,
    source: 1,
  }));
}

function scrollScore(samples: ScrollSample[]): number | null {
  return new ScoreComputer().evaluate([], 0, [], samples).score;
}

function fakeWindow(): { target: EventTarget; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  const target = new EventTarget();
  globals.window = target;
  return {
    target,
    restore: () => {
      if (previous === undefined) delete globals.window;
      else globals.window = previous;
    },
  };
}

function event(type: string, props: Record<string, unknown>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(result, key, { value, configurable: true });
  }
  return result;
}

describe("Flota de bots de scroll", () => {
  it("wheel regular (60/16/120ms) con delta 100 -> score alto", () => {
    expect(scrollScore(wheelBot(60))).toBeGreaterThan(0.9);
    expect(scrollScore(wheelBot(16, 40))).toBeGreaterThan(0.9);
    expect(scrollScore(wheelBot(120))).toBeGreaterThan(0.9);
  });

  it("scrollTo/PageDown con saltos >=300 y cadencia lenta -> score >= 0.55", () => {
    expect(scrollScore(jumpBot(300, 120))).toBeGreaterThanOrEqual(0.55);
    expect(scrollScore(jumpBot(600, 500))).toBeGreaterThanOrEqual(0.55);
    expect(scrollScore(jumpBot(800, 700))).toBeGreaterThanOrEqual(0.55);
    // La medida específica de salto grande es la que sostiene el umbral.
    expect(extractScrollFeatures(jumpBot(600, 500)).largeJumps).toBe(1);
  });

  it("bot humanizado y anti-detector -> scores bajos", () => {
    expect(scrollScore(HUMANIZADO)).toBeLessThan(0.3);
    expect(scrollScore(ANTIDETECTOR)).toBeLessThan(0.3);
  });

  it("autoscroll humano (source=1, ritmo de frame) no puntúa", () => {
    const samples = humanAutoscroll();
    expect(samples.length).toBeGreaterThanOrEqual(SCROLL_EVIDENCE);
    // La racha completa se excluye: no queda evidencia de scroll.
    expect(withoutAutoscroll(samples)).toEqual([]);
    expect(scrollScore(samples)).toBeNull();
    // Una sola muestra fugada no basta para marcar racha: sí puntúa.
    expect(withoutAutoscroll(samples.slice(0, 5))).toHaveLength(5);
  });

  it("convivir con wheel bot: se excluye el autoscroll y se puntúa el wheel", () => {
    const wheel = wheelBot(60, 20).map((sample) => ({ ...sample, t: 6000 + sample.t }));
    const score = scrollScore([...humanAutoscroll(), ...wheel]);
    expect(score).toBeGreaterThan(0.9);
  });

  it("getVerdict sigue en human aunque el único scroll sea autoscroll", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      // Mouse humano para fijar el estado (veredicto humano confirmado).
      let mouseT = 0;
      for (let i = 0; i < 30; i += 1) {
        mouseT += 35 + ((i * 37) % 130) + (i % 7 === 3 ? 200 : 0);
        target.dispatchEvent(
          event("pointermove", {
            clientX: i * 7 + 0.5,
            clientY: (i % 5) * 9 + 0.25,
            timeStamp: mouseT,
            pointerType: "mouse",
            isTrusted: false,
          }),
        );
        if ((i + 1) % 5 === 0 || i === 29) detector.evaluate();
      }
      expect(detector.getVerdict().state).toBe("human");

      const host = target as EventTarget & { scrollY: number };
      for (let i = 0; i < 40; i += 1) {
        host.scrollY = i * 40;
        target.dispatchEvent(event("scroll", { timeStamp: 5000 + i * 16, isTrusted: false }));
      }
      detector.evaluate();

      expect(detector.getRecentScrolls()).toHaveLength(40);
      expect(detector.getSignalScores().scroll).toBeNull();
      expect(detector.getVerdict().state).toBe("human");
      expect(detector.getVerdict().score as number).toBeLessThan(AI_MIN);
      detector.stop();
    } finally {
      restore();
    }
  });
});
