// Helpers compartidos por el simulador y el auto-test: mismos generadores
// deterministas y la misma medición con el scorer público de la librería.
// El target es artificial; ninguna función toca el detector en vivo ni el DOM.

import {
  AI_MIN,
  createMouseCollector,
  HUMAN_MAX,
  type PointerSample,
  ScoreComputer,
} from "is-that-an-ai";
import { type DemoTranslationKey, tr } from "#lib/i18n";

export type Band = "humano" | "zona media" | "agente" | "sin evidencia";

export interface SyntheticEvent {
  clientX: number;
  clientY: number;
  timeStamp: number;
  pointerType: string;
  isTrusted: boolean;
}

export interface SyntheticTarget {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  emit(type: string, event: SyntheticEvent): void;
}

export interface SimulationResult {
  id: string;
  samples: PointerSample[];
  score: number | null;
  band: Band;
  detected: boolean;
  reason: string;
}

export function bandOf(score: number | null): Band {
  if (score === null) return "sin evidencia";
  if (score <= HUMAN_MAX) return "humano";
  if (score >= AI_MIN) return "agente";
  return "zona media";
}

/** Generador determinista: misma semilla, mismas muestras en cada ejecución. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (1664525 * a + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function makeWriter(): (points: PointerSample[], x: number, y: number, dt: number) => void {
  let seq = 0;
  let t = 0;
  return (points, x, y, dt) => {
    t += dt;
    points.push({ seq: ++seq, x, y, t, kind: 0, pointerType: 0, trusted: 0 });
  };
}

export function naiveBot(): PointerSample[] {
  const points: PointerSample[] = [];
  const push = makeWriter();
  let x = 94;
  push(points, x, 180, 0);
  for (let block = 0; block < 5; block += 1) {
    for (let i = 0; i < 6; i += 1) {
      x += 11;
      push(points, x, 180, 16);
    }
    if (block < 4) {
      x += 150;
      push(points, x, 180, 16);
    }
  }
  return points;
}

export function humanLike(
  seed: number,
  options: { jitter: number; pauseEvery: number; pauseMs: number; overshoot?: boolean },
): PointerSample[] {
  const points: PointerSample[] = [];
  const push = makeWriter();
  const rnd = random(seed);
  for (let i = 0; i < 48; i += 1) {
    const phase = i / 47;
    const x = 94 + 616 * phase + (rnd() - 0.5) * options.jitter;
    const y = 300 + 55 * Math.sin(phase * Math.PI * 2) + (rnd() - 0.5) * options.jitter;
    const dt = 18 + rnd() * 45 + (i > 0 && i % options.pauseEvery === 0 ? options.pauseMs : 0);
    push(points, x, y, i === 0 ? 0 : dt);
  }
  if (options.overshoot) {
    push(points, 716, 296 + (rnd() - 0.5) * 8, 60);
    push(points, 706, 302 + (rnd() - 0.5) * 8, 90);
    push(points, 720, 300 + (rnd() - 0.5) * 8, 110);
  }
  return points;
}

export function syntheticTarget(): SyntheticTarget {
  const listeners = new Map<string, (event: Event) => void>();
  return {
    addEventListener(type, listener) {
      if (typeof listener === "function") listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type, event) {
      listeners.get(type)?.(event as unknown as Event);
    },
  };
}

/** Mide un trazo con el colector público y una evaluación sin suavizado EMA. */
export function measure(id: string, points: PointerSample[]): SimulationResult {
  const target = syntheticTarget();
  const clock = { t: 0 };
  const collector = createMouseCollector({
    target: target as unknown as EventTarget,
    now: () => clock.t,
    bufferSize: 1024,
  });
  collector.attach();
  for (const p of points) {
    clock.t = p.t;
    target.emit("pointermove", {
      clientX: p.x,
      clientY: p.y,
      timeStamp: p.t,
      pointerType: "mouse",
      isTrusted: false,
    });
  }
  collector.detach();

  const samples = collector.getSamples();
  const windowMs = samples.length >= 2 ? samples[samples.length - 1].t - samples[0].t : 0;
  const evidence = new ScoreComputer().evaluate(samples, windowMs);
  const band = bandOf(evidence.score);
  return {
    id,
    samples,
    score: evidence.score,
    band,
    detected: band === "agente",
    reason: evidence.reasons[0] ?? tr("noReasons"),
  };
}

export interface SimulationProfile {
  id: string;
  nameKey: DemoTranslationKey;
  detailKey: DemoTranslationKey;
  expected: Band;
  limitationKey: DemoTranslationKey;
  generate: () => PointerSample[];
}

export const PROFILES: SimulationProfile[] = [
  {
    id: "naive",
    nameKey: "profile.naive.name",
    detailKey: "profile.naive.detail",
    expected: "agente",
    limitationKey: "profile.naive.limitation",
    generate: naiveBot,
  },
  {
    id: "humanized",
    nameKey: "profile.humanized.name",
    detailKey: "profile.humanized.detail",
    expected: "humano",
    limitationKey: "profile.humanized.limitation",
    generate: () => humanLike(42, { jitter: 6, pauseEvery: 13, pauseMs: 180 }),
  },
  {
    id: "replay",
    nameKey: "profile.replay.name",
    detailKey: "profile.replay.detail",
    expected: "humano",
    limitationKey: "profile.replay.limitation",
    generate: () => humanLike(7, { jitter: 9, pauseEvery: 9, pauseMs: 220, overshoot: true }),
  },
];
