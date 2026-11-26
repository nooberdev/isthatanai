// Etapa 10 — integración en detector y scorer. Tests 100% deterministas:
// reloj inyectado, EventTarget propio y globals falsos. Sin red, sin storage y
// sin DOM real. No se tocan los scores calibrados de las etapas anteriores.

import { describe, expect, it } from "bun:test";
import { IsThatAnAI } from "../src/core/detector";
import { LivenessMonitor } from "../src/core/liveness";
import {
  JITTER_SESSION_THRESHOLD,
  NO_JITTER_SEED,
  ScoreComputer,
  SIGNAL_WEIGHTS,
} from "../src/scoring/score";
import type { PointerSample, ScoreBreakdown } from "../src/types";

const MEASURING = {
  state: "measuring",
  score: null,
  confidence: 0,
  doubt: 1,
  reasons: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** EventTarget mínimo que entrega objetos planos (permite fijar isTrusted). */
class TestTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== "function" && (listener === null || typeof listener !== "object")) {
      return;
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as EventListenerOrEventListenerObject);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listeners.get(type)?.delete(listener as EventListenerOrEventListenerObject);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
    return true;
  }

  emit(type: string, props: Record<string, unknown>): void {
    this.dispatchEvent({ type, ...props } as unknown as Event);
  }
}

function move(x: number, y: number, t: number): Record<string, unknown> {
  return {
    type: "pointermove",
    clientX: x,
    clientY: y,
    timeStamp: t,
    pointerType: "mouse",
    isTrusted: true,
  };
}

interface Session {
  detector: IsThatAnAI;
  target: TestTarget;
  clock: { value: number };
  restore: () => void;
}

/** Sesión aislada con target inyectado: nunca se consulta window/document. */
function session(options: Record<string, unknown> = {}): Session {
  const target = new TestTarget();
  const clock = { value: 0 };
  const detector = new IsThatAnAI({ ...options, now: () => clock.value });
  detector.attachTo(target);
  detector.start();
  return {
    detector,
    target,
    clock,
    restore: () => detector.stop(),
  };
}

function sample(x: number, y: number, t: number, seq: number): PointerSample {
  return { seq, x, y, t, kind: 0, pointerType: 0, trusted: 1 };
}

// ---------------------------------------------------------------------------
// 1. Guardarraíles = evidencia aditiva; scores calibrados intactos
// ---------------------------------------------------------------------------

describe("Etapa 10 · evidencia aditiva y scores calibrados", () => {
  it("el detector produce EXACTAMENTE el score de un ScoreComputer sin configurar", () => {
    const { detector, target, restore } = session();
    try {
      const samples = Array.from({ length: 30 }, (_, i) => sample(i * 10, i * 7, i * 60, i + 1));
      for (const s of samples) target.emit("pointermove", move(s.x, s.y, s.t));
      detector.evaluate();
      const expected = new ScoreComputer().evaluate(samples, 29 * 60).score;
      expect(detector.getVerdict().score).toBe(expected);
      expect(Object.keys(detector.getVerdict())).toEqual([
        "state",
        "score",
        "confidence",
        "doubt",
        "reasons",
      ]);
      expect(Object.keys(detector.getConfig())).toEqual([
        "thresholds",
        "signalWeights",
        "device",
        "combination",
        "accessibilityProtection",
        "confirmMs",
        "emaAlpha",
      ]);
    } finally {
      restore();
    }
  });

  it("las guardarraíles no alteran el score: con antiCheat=false da el mismo número", () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample(i * 10, i * 3, i * 60, i + 1));
    const clicks = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      x: 50,
      y: 50,
      t: 1000 + i * 80,
      kind: (i % 2) as 0 | 1,
      button: 0,
      trusted: 1,
    }));
    const withGuards = new ScoreComputer().evaluate(samples, 29 * 60, clicks);
    const withoutGuards = new ScoreComputer();
    withoutGuards.configure({ antiCheat: false });
    expect(withoutGuards.evaluate(samples, 29 * 60, clicks).score).toBe(withGuards.score);
    // La evidencia de riesgo SÍ se calcula y se expone por separado.
    expect(withGuards.score).not.toBeNull();
  });

  it("una falla de coherencia eleva la evidencia de riesgo sin tocar el score", () => {
    const clicks = Array.from({ length: 12 }, (_, i) => ({
      seq: i + 1,
      x: 50,
      y: 50,
      t: i * 80,
      kind: (i % 2) as 0 | 1,
      button: 0,
      trusted: 1,
    }));
    const inputs = Array.from({ length: 12 }, (_, i) => ({
      seq: i + 1,
      t: 400 + i * 80,
      kind: 0 as const,
      inputType: 0 as const,
      trusted: 1,
    }));
    const computer = new ScoreComputer();
    computer.evaluate([], 0, clicks, [], [], inputs);
    const risk = computer.getGuardrailRisk();
    expect(risk.coherence).toBeGreaterThan(0.5);
    expect(risk.overall).toBeGreaterThanOrEqual(risk.coherence);
    expect(risk.replay).toBe(0);
    expect(risk.surprise).toBe(0);
    const breakdownRisk: unknown = computer.getScoringSnapshot().riskEvidence;
    expect(breakdownRisk).toEqual(risk);
  });

  it("el breakdown expone la evidencia y notas sin cambiar las formas fijadas", () => {
    const { detector, restore } = session();
    try {
      const breakdown = detector.getScoreBreakdown() as ScoreBreakdown;
      expect(breakdown.scores).toEqual({ mouse: null, click: null, scroll: null });
      expect(Object.keys(breakdown.scores)).toEqual(["mouse", "click", "scroll"]);
      expect(breakdown.riskEvidence.overall).toBe(0);
      expect(Array.isArray(breakdown.notes)).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Replay dentro de la sesión
// ---------------------------------------------------------------------------

describe("Etapa 10 · replay en memoria", () => {
  it("detecta una trayectoria idéntica repetida y la expone como riesgo y razón", () => {
    const { detector, target, clock, restore } = session({ locale: "es" });
    try {
      const burst = (offset: number) =>
        Array.from({ length: 10 }, (_, i) => ({
          x: 100 + i * 12,
          y: 40 + (i % 3) * 9,
          t: offset + i * 55,
        }));
      for (const p of burst(0)) target.emit("pointermove", move(p.x, p.y, p.t));
      clock.value = 600;
      detector.evaluate();
      const first = detector.getReplaySignals();
      expect(first.identicalSequence).toBe(0);

      // Misma ruta y mismo ritmo, con el reloj desplazado: es un replay.
      for (const p of burst(2000)) target.emit("pointermove", move(p.x, p.y, p.t));
      clock.value = 2600;
      detector.evaluate();
      const signals = detector.getReplaySignals();
      expect(Object.keys(signals)).toEqual(["repeatedPath", "repeatedTiming", "identicalSequence"]);
      expect(signals.identicalSequence).toBeGreaterThan(0.9);
      expect(detector.getScoreBreakdown().riskEvidence.replay).toBeGreaterThan(0.9);
      expect(detector.getVerdict().reasons).toContain("Trayectoria idéntica repetida en la sesión");
    } finally {
      restore();
    }
  });

  it("reset() borra el historial de replay: la repetición es solo de la sesión", () => {
    const { detector, restore } = session();
    try {
      detector.evaluate();
      expect(detector.getReplaySignals().identicalSequence).toBe(0);
      detector.reset();
      expect(detector.getReplaySignals()).toEqual({
        repeatedPath: 0,
        repeatedTiming: 0,
        identicalSequence: 0,
      });
      expect(detector.getVerdict()).toEqual(MEASURING);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed por integridad
// ---------------------------------------------------------------------------

describe("Etapa 10 · integridad fail-closed", () => {
  it("verifyIntegrity().ok=false fuerza measuring con score null y una razón", () => {
    const { detector, target, restore } = session();
    try {
      // Rompemos la superficie pública que verifica `verifyIntegrity()` sin
      // tocar el reloj inyectado ni el DOM. Se restaura en `finally`.
      const globals = globalThis as unknown as { Date?: unknown };
      const previousDate = globals.Date;
      globals.Date = undefined;
      try {
        for (let i = 0; i < 30; i += 1) {
          target.emit("pointermove", move(i * 10, i * 5, i * 60));
        }
        detector.evaluate();
        const integrity = detector.getIntegrity();
        expect(integrity.ok).toBe(false);
        expect(integrity.checks.some((check) => check.ok === false)).toBe(true);
        const verdict = detector.getVerdict();
        expect(verdict.state).toBe("measuring");
        expect(verdict.score).toBeNull();
        expect(verdict.confidence).toBe(0);
        expect(verdict.reasons).toContain("Integrity verified: tampering detected");
        expect(detector.getScoreBreakdown().notes).toContain(
          "Integridad verificada: manipulación detectada",
        );
      } finally {
        globals.Date = previousDate;
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Liveness (solo observabilidad)
// ---------------------------------------------------------------------------

describe("Etapa 10 · liveness", () => {
  it("pasa de idle a live y a stale sin generar veredicto", () => {
    const { detector, target, clock, restore } = session();
    const seen: string[] = [];
    const off = detector.onLiveness((status) => seen.push(status));
    try {
      expect(detector.getLiveness()).toEqual({
        status: "idle",
        lastBeatAt: 0,
        intervalMs: new LivenessMonitor().intervalMs,
      });
      for (let i = 0; i < 12; i += 1) {
        target.emit("pointermove", move(i * 10, i * 4, i * 60));
      }
      clock.value = 600;
      detector.evaluate();
      expect(detector.getLiveness().status).toBe("live");
      expect(detector.getLiveness().lastBeatAt).toBe(600);

      const staleAt = 600 + detector.getLiveness().intervalMs * 5 + 1;
      expect(detector.getLiveness(staleAt).status).toBe("stale");
      // El estado inicial ya es `idle`, así que solo se emiten los Cambios
      // reales: idle -> live -> stale.
      expect(seen).toEqual(["live", "stale"]);

      // La liveness NUNCA clasifica: con evidencia el score sigue siendo numérico
      // (el estado puede ser `measuring` por la histeresis de confirmación).
      expect(detector.getVerdict().score).not.toBeNull();
      off();
      const before = seen.length;
      detector.getLiveness(600);
      expect(seen.length).toBe(before);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Jitter determinista por sesión
// ---------------------------------------------------------------------------

describe("Etapa 10 · jitter de pesos", () => {
  const runSessionWithEvaluations = (
    options: Record<string, unknown>,
  ): { breakdown: ScoreBreakdown; before: ScoreBreakdown } => {
    const { detector, target, clock, restore } = session(options);
    try {
      let before: ScoreBreakdown | null = null;
      const evaluations = JITTER_SESSION_THRESHOLD + 2;
      for (let e = 0; e < evaluations; e += 1) {
        for (let i = 0; i < 12; i += 1) {
          const t = e * 1000 + i * 60;
          target.emit("pointermove", move(e * 7 + i * 10, i * 3, t));
        }
        clock.value = e * 1000 + 660;
        detector.evaluate();
        if (e === JITTER_SESSION_THRESHOLD - 2) before = detector.getScoreBreakdown();
      }
      if (before === null) throw new Error("falta la instantánea previa al umbral");
      return { breakdown: detector.getScoreBreakdown(), before };
    } finally {
      restore();
    }
  };

  it("no se aplica antes del umbral y es idéntico para sesiones iguales", () => {
    const a = runSessionWithEvaluations({});
    const b = runSessionWithEvaluations({});
    expect(a.before.effectiveWeights).toEqual(a.before.weights);
    expect(a.breakdown.effectiveWeights).toEqual(b.breakdown.effectiveWeights);
    expect(a.breakdown.effectiveWeights).not.toEqual(SIGNAL_WEIGHTS);
    expect(NO_JITTER_SEED).toBe(0);
  });

  it("antiCheatWeightJitter=false conserva los pesos configurados", () => {
    const { breakdown } = runSessionWithEvaluations({ antiCheatWeightJitter: false });
    expect(breakdown.effectiveWeights).toEqual(SIGNAL_WEIGHTS);
  });
});

// ---------------------------------------------------------------------------
// 6. SSR
// ---------------------------------------------------------------------------

describe("Etapa 10 · SSR", () => {
  it("importar y usar la API nueva sin window/document/navigator no lanza", () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const { IsThatAnAI } = await import(${JSON.stringify(entry)});`,
      "const target = new EventTarget();",
      "const detector = new IsThatAnAI({ now: () => 0 });",
      "detector.attachTo(target);",
      "detector.start();",
      "detector.evaluate();",
      "const out = {",
      "  verdict: detector.getVerdict(),",
      "  replay: detector.getReplaySignals(),",
      "  surprise: detector.getSurpriseCheck(),",
      "  integrityOk: detector.getIntegrity().ok,",
      "  liveness: detector.getLiveness(),",
      "  antiCheat: detector.getAntiCheat(),",
      "  jitter: detector.getAntiCheatWeightJitter(),",
      "  risk: detector.getScoreBreakdown().riskEvidence.overall,",
      "};",
      "detector.stop();",
      "console.log(JSON.stringify(out));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(result.stdout).trim());
    expect(out.verdict).toEqual(MEASURING);
    expect(out.replay).toEqual({
      repeatedPath: 0,
      repeatedTiming: 0,
      identicalSequence: 0,
    });
    expect(out.surprise.passed).toBe(true);
    expect(out.integrityOk).toBe(true);
    // evaluate() late aunque no haya muestras: liveness pasa a `live`.
    expect(out.liveness.status).toBe("live");
    expect(out.liveness.lastBeatAt).toBe(0);
    expect(out.antiCheat).toBe(true);
    expect(out.jitter).toBe(true);
    expect(out.risk).toBe(0);
  });
});
