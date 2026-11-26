import { describe, expect, it } from "bun:test";
import type { ClickSample } from "../src/index";
import { clickAimConsistency, IsThatAnAI, ScoreComputer } from "../src/index";

interface ClickSpec {
  x: number;
  y: number;
  downT: number;
  duration: number;
}

function build(specs: ClickSpec[]): ClickSample[] {
  const out: ClickSample[] = [];
  for (const spec of specs) {
    out.push({
      seq: out.length + 1,
      x: spec.x,
      y: spec.y,
      t: spec.downT,
      kind: 0,
      button: 0,
      trusted: 1,
    });
    out.push({
      seq: out.length + 1,
      x: spec.x,
      y: spec.y,
      t: spec.downT + spec.duration,
      kind: 1,
      button: 0,
      trusted: 1,
    });
  }
  return out;
}

function samePoint(count: number, interval: number, duration: number, t0 = 0): ClickSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    x: 400.5,
    y: 300.25,
    downT: t0 + i * interval,
    duration,
  }));
}

const DOUBLE = samePoint(2, 120, 80);
const TRIPLE: ClickSpec[] = [
  { x: 400.5, y: 300.25, downT: 0, duration: 80 },
  { x: 400.5, y: 300.25, downT: 190, duration: 80 },
  { x: 400.5, y: 300.25, downT: 320, duration: 80 },
];
/** 4 pares con ventana suficiente: comprueba que manda el conteo de muestras. */
const FOUR_SLOW = samePoint(4, 300, 100);
const HUMAN: ClickSpec[] = [
  { x: 120.3, y: 90.25, downT: 0, duration: 80 },
  { x: 480.7, y: 310.5, downT: 180, duration: 165 },
  { x: 305.2, y: 200.75, downT: 600, duration: 55 },
  { x: 710.9, y: 410.25, downT: 730, duration: 210 },
  { x: 250.4, y: 150.5, downT: 1290, duration: 95 },
  { x: 595.6, y: 350.75, downT: 1530, duration: 140 },
];
const FAST_BOT = samePoint(12, 60, 30);
const REGULAR_BOT = samePoint(8, 300, 100);

function scoreOf(specs: ClickSpec[]): number | null {
  return new ScoreComputer().evaluate([], 0, build(specs), []).score;
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

/** Ratón humano convincente (duda 0) para aislar la señal de clic. */
function dispatchHumanMouse(target: EventTarget, detector: IsThatAnAI): void {
  let x = 0.5;
  let y = 0;
  let t = 0;
  for (let i = 0; i < 30; i += 1) {
    const dt = 35 + ((i * 37) % 130) + (i % 7 === 3 ? 200 : 0);
    const dx = 3 + ((i * 17) % 16) + 0.4;
    x += i % 5 === 2 ? -dx * 0.8 : dx;
    y += ((i * 5) % 7) - 3 + 0.2;
    t += dt;
    target.dispatchEvent(
      event("pointermove", {
        clientX: x,
        clientY: y,
        timeStamp: t,
        pointerType: "mouse",
        isTrusted: false,
      }),
    );
    if ((i + 1) % 5 === 0 || i === 29) detector.evaluate();
  }
}

describe("Flota local de clics", () => {
  it("doble y triple clic -> evidencia insuficiente (null)", () => {
    expect(scoreOf(DOUBLE)).toBeNull();
    expect(scoreOf(TRIPLE)).toBeNull();
    expect(scoreOf(FOUR_SLOW)).toBeNull(); // 8 muestras pero < 10
    expect(new ScoreComputer().evaluate([], 0, build(DOUBLE), []).score).toBeNull();
  });

  it("6 clics humanos con posiciones/tiempos variables -> score < 0.30", () => {
    const score = scoreOf(HUMAN);
    expect(score).not.toBeNull();
    expect(score as number).toBeLessThan(0.3);
  });

  it("bot rápido regular -> score >= 0.9; bot regular -> score >= 0.55", () => {
    expect(scoreOf(FAST_BOT) as number).toBeGreaterThanOrEqual(0.9);
    expect(scoreOf(REGULAR_BOT) as number).toBeGreaterThanOrEqual(0.55);
  });

  it("la razón de puntería no aparece con dispersión amplia", () => {
    // La medida directa baja del umbral de razón (0.55) con posiciones variables.
    expect(clickAimConsistency(build(HUMAN))).toBeLessThan(0.55);
    // El bot que repite el mismo punto sí mantiene la medida alta.
    expect(clickAimConsistency(build(FAST_BOT))).toBe(1);
  });
});

describe("Veredicto con doble/triple clic", () => {
  for (const [label, specs] of [
    ["doble clic", DOUBLE],
    ["triple clic", TRIPLE],
  ] as const) {
    it(`${label}: human y duda baja, sin score de clic`, () => {
      const { target, restore } = fakeWindow();
      try {
        const detector = new IsThatAnAI();
        detector.start();
        dispatchHumanMouse(target, detector);
        expect(detector.getVerdict().state).toBe("human");

        const clickEvents: Event[] = [];
        for (const sample of build(specs)) {
          clickEvents.push(
            event(sample.kind === 0 ? "pointerdown" : "pointerup", {
              clientX: sample.x,
              clientY: sample.y,
              timeStamp: 4000 + sample.t,
              button: sample.button,
              isTrusted: false,
            }),
          );
        }
        for (const clickEvent of clickEvents) target.dispatchEvent(clickEvent);
        detector.evaluate();

        expect(detector.getSignalScores().click).toBeNull();
        expect(detector.getVerdict().state).toBe("human");
        expect(detector.getVerdict().doubt).toBeLessThan(0.35);
        detector.stop();
      } finally {
        restore();
      }
    });
  }
});
