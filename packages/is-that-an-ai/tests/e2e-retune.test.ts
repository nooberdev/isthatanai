import { describe, expect, it } from "bun:test";
import type { ClickSample, PointerSample, ScrollSample } from "../src/index";
import {
  AI_MIN,
  computeClickScore,
  computeScrollScore,
  extractClickFeatures,
  extractScrollFeatures,
  IsThatAnAI,
} from "../src/index";

/** PRNG determinista para reproducir las secuencias del E2E sin dependencias. */
function makeRand(initial: number): () => number {
  let seed = initial;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

/** 12 clics: duraciones 60-180ms, intervalos 120-520ms, puntería variable. */
function e2eHumanClicks(): ClickSample[] {
  const rand = makeRand(12345);
  const out: ClickSample[] = [];
  let t = 0;
  let seq = 1;
  for (let i = 0; i < 12; i += 1) {
    const duration = 60 + Math.floor(rand() * 121);
    const x = 100 + i * 37 + rand() * 20;
    const y = 50 + (i % 4) * 60 + rand() * 15;
    out.push({ seq: seq++, x, y, t, kind: 0, button: 0, trusted: 1 });
    out.push({ seq: seq++, x, y, t: t + duration, kind: 1, button: 0, trusted: 1 });
    t += 120 + Math.floor(rand() * 401);
  }
  return out;
}

/** 16 wheel: deltas 80-120, delays 30-120ms, con reversiones y pausas humanas. */
function e2eHumanScrolls(): ScrollSample[] {
  const rand = makeRand(54321);
  const out: ScrollSample[] = [];
  let t = 0;
  for (let i = 0; i < 16; i += 1) {
    const delta = 80 + Math.floor(rand() * 41);
    const sign = i % 5 === 4 ? -1 : 1;
    out.push({ seq: i + 1, dx: 0, dy: sign * delta, t, trusted: 1, source: 0 });
    t += 30 + Math.floor(rand() * 91) + (i % 6 === 0 ? 400 : 0);
  }
  return out;
}

/** Bot de clics: intervalos exactos, ráfaga y siempre el mismo punto. */
function botClicks(): ClickSample[] {
  const out: ClickSample[] = [];
  for (let i = 0; i < 12; i += 1) {
    const t = i * 100;
    out.push({ seq: out.length + 1, x: 500.5, y: 300.25, t, kind: 0, button: 0, trusted: 1 });
    out.push({
      seq: out.length + 1,
      x: 500.5,
      y: 300.25,
      t: t + 60,
      kind: 1,
      button: 0,
      trusted: 1,
    });
  }
  return out;
}

/** Bot de scroll: delta y retardo exactos, sin reversiones ni pausas. */
function botScrolls(): ScrollSample[] {
  return Array.from({ length: 16 }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: 100,
    t: i * 60,
    trusted: 1,
    source: 0 as const,
  }));
}

/** Mouse humano convincente: pasos fraccionarios, dt irregular y pausas. */
function humanMouse(count: number): PointerSample[] {
  const rand = makeRand(99);
  const out: PointerSample[] = [];
  let x = 0.5;
  let y = 0;
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    const dt = 35 + Math.floor(rand() * 130) + (i % 7 === 3 ? 200 : 0);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    x += i % 5 === 2 ? -dx * 0.8 : dx;
    y += ((i * 5) % 7) - 3 + 0.2;
    t += dt;
    out.push({
      seq: i + 1,
      x,
      y,
      t,
      kind: 0,
      pointerType: 0,
      trusted: 1,
    });
  }
  return out;
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

describe("Retune E2E: clics y scroll", () => {
  it("clics humanos del E2E (duración/intervalo aleatorios) -> score bajo", () => {
    const score = computeClickScore(extractClickFeatures(e2eHumanClicks()));
    expect(score).toBeLessThan(0.5);
    expect(score).toBeLessThan(0.3);
  });

  it("scroll humano del E2E (deltas/delays aleatorios) -> score bajo", () => {
    const score = computeScrollScore(extractScrollFeatures(e2eHumanScrolls()));
    expect(score).toBeLessThan(0.5);
    expect(score).toBeLessThan(0.4);
  });

  it("bots con intervalos exactos, ráfaga y puntería fija -> scores altos", () => {
    expect(computeClickScore(extractClickFeatures(botClicks()))).toBeGreaterThan(0.7);
    expect(computeScrollScore(extractScrollFeatures(botScrolls()))).toBeGreaterThan(0.7);
  });

  it("las señales humanas no sacan al detector de human", () => {
    const { target, restore } = fakeWindow();
    try {
      const detector = new IsThatAnAI();
      detector.start();
      const mouse = humanMouse(30);
      for (let i = 0; i < mouse.length; i += 1) {
        target.dispatchEvent(
          event("pointermove", {
            clientX: mouse[i].x,
            clientY: mouse[i].y,
            timeStamp: mouse[i].t,
            pointerType: "mouse",
            isTrusted: false,
          }),
        );
        if ((i + 1) % 5 === 0 || i === mouse.length - 1) detector.evaluate();
      }
      expect(detector.getVerdict().state).toBe("human");
      const mouseOnly = detector.getVerdict().score as number;
      expect(mouseOnly).toBeLessThan(0.5);

      for (const click of e2eHumanClicks()) {
        target.dispatchEvent(
          event(click.kind === 0 ? "pointerdown" : "pointerup", {
            clientX: click.x,
            clientY: click.y,
            timeStamp: click.t,
            button: click.button,
            isTrusted: false,
          }),
        );
      }
      for (const scroll of e2eHumanScrolls()) {
        target.dispatchEvent(
          event("wheel", {
            deltaX: scroll.dx,
            deltaY: scroll.dy,
            deltaMode: 0,
            timeStamp: scroll.t + 5000,
            isTrusted: false,
          }),
        );
      }
      detector.evaluate();

      expect(detector.getVerdict().state).toBe("human");
      expect(detector.getSignalScores().click).toBeLessThan(0.5);
      expect(detector.getSignalScores().scroll).toBeLessThan(0.5);
      expect(detector.getVerdict().score as number).toBeLessThan(AI_MIN);
      detector.stop();
    } finally {
      restore();
    }
  });
});
