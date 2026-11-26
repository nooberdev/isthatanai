// Auditoría "real world" de las guardarraíles de coherencia/entorno (L137-L154)
// y anti-trampas (L210-L217). Cada caso alimenta las funciones con MUESTRAS
// ACUMULADAS reales (no valores de retorno inventados), y comprueba que:
//   1. el resultado siempre es finito y está en [0,1];
//   2. la dirección es correcta (0 en el humano, alto en el ataque);
//   3. con evidencia insuficiente NO se acusa nada (fail-closed).
// Cubre además entradas numéricas hostiles, SSR en proceso hijo sin DOM y
// comportamiento O(n log n) en sesiones grandes.

import { describe, expect, it } from "bun:test";
import { evaluateCoherence, evaluateCoherenceDetailed } from "../../src/core/coherence";
import { inferDeviceProfile } from "../../src/core/device-profile";
import { type EnvironmentHints, evaluateEnvironment } from "../../src/core/environment";
import { declaredVsBehavior, humanizationRisk, injectionRisk } from "../../src/core/injection";
import { LivenessMonitor } from "../../src/core/liveness";
import { formulaRhythm, noiseHumanity } from "../../src/core/noise";
import { detectReplay, type ReplayInput, ReplayTracker } from "../../src/core/replay";
import { surpriseCoherenceCheck } from "../../src/core/surprise";
import { integrityFingerprint, verifyIntegrity } from "../../src/core/tamper";
import { hasKeyboardEvidence, keyboardIntervalRegularity } from "../../src/features/keyboard";
import { mouseIntervalRegularity } from "../../src/features/mouse";
import { ScoreComputer, SIGNAL_WEIGHTS } from "../../src/scoring/score";
import type {
  ClickSample,
  InputSample,
  KeyCategory,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../../src/types";

// ---------------------------------------------------------------------------
// Utilidades deterministas
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Fixture {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
}

const fixture = (): Fixture => ({ points: [], clicks: [], scrolls: [], keys: [], inputs: [] });

function point(
  t: number,
  kind: 0 | 1 | 2 = 0,
  pointerType: 0 | 1 | 2 | 3 = 0,
  trusted: 0 | 1 = 1,
): PointerSample {
  return { seq: Math.round(t), x: 100, y: 200, t, kind, pointerType, trusted };
}
function click(t: number, kind: 0 | 1 = 0, trusted: 0 | 1 = 1): ClickSample {
  return { seq: Math.round(t), x: 100, y: 200, t, kind, button: 0, trusted };
}
function scroll(t: number): ScrollSample {
  return { seq: Math.round(t), dx: 0, dy: 12, t, trusted: 1, source: 0 };
}
function key(t: number, kind: 0 | 1 = 0, trusted: 0 | 1 = 1, category: KeyCategory = 0): KeySample {
  return { seq: Math.round(t), t, kind, category, trusted };
}
function input(t: number, trusted: 0 | 1 = 1): InputSample {
  return { seq: Math.round(t), t, kind: 0, inputType: 0, trusted };
}
function series(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function intervalsOf(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i] - sorted[i - 1];
    if (dt > 0 && Number.isFinite(dt)) out.push(dt);
  }
  return out;
}
function downIntervals(keys: KeySample[]): number[] {
  return intervalsOf(keys.filter((k) => k.kind === 0).map((k) => k.t));
}

function expectUnit(value: number, label: string): void {
  expect(typeof value, `${label}: tipo`).toBe("number");
  expect(Number.isFinite(value), `${label}: finito`).toBe(true);
  expect(value, `${label}: >= 0`).toBeGreaterThanOrEqual(0);
  expect(value, `${label}: <= 1`).toBeLessThanOrEqual(1);
}
function expectAllUnit(signals: Record<string, number>, label: string): void {
  for (const [field, value] of Object.entries(signals)) expectUnit(value, `${label}.${field}`);
}
function expectFires(value: number, label: string, min = 0.2): void {
  expectUnit(value, label);
  expect(value, `${label}: dispara`).toBeGreaterThanOrEqual(min);
}

// ---------------------------------------------------------------------------
// Escenarios END-TO-END (muestras reales acumuladas)
// ---------------------------------------------------------------------------

/** Humano: mueve el ratón hacia el campo, clic, escribe con pausas naturales. */
function humanSession(seed = 0x1111): Fixture {
  const rng = lcg(seed);
  const f = fixture();
  let seq = 0;
  let t = 1000;
  for (let burst = 0; burst < 3; burst += 1) {
    const targetX = 200 + burst * 130;
    // Aproximación del puntero (jitter correlacionado, lejos de la escritura).
    for (let m = 0; m < 6; m += 1) {
      t += 40 + rng() * 120 + (rng() < 0.15 ? 200 * rng() : 0);
      f.points.push({
        seq: seq++,
        x: targetX - 60 + m * 10 + rng() * 6,
        y: 300 + rng() * 8,
        t,
        kind: 0,
        pointerType: 0,
        trusted: 1,
      });
    }
    // El humano enfoca el campo con un clic antes de escribir.
    t += 30 + rng() * 40;
    const down = t;
    f.clicks.push({ seq: seq++, x: targetX, y: 300, t: down, kind: 0, button: 0, trusted: 1 });
    f.clicks.push({
      seq: seq++,
      x: targetX,
      y: 300,
      t: down + 60 + rng() * 80,
      kind: 1,
      button: 0,
      trusted: 1,
    });
    // Ráfaga de tecleo: ritmo variable, pausas ocasionales, pulsa y suelta.
    t = down + 300;
    let hold = 0;
    for (let k = 0; k < 10; k += 1) {
      const interval = 90 + hold * 0.4 + (rng() - 0.5) * 70 + (rng() < 0.12 ? 250 * rng() : 0);
      hold = hold * 0.5 + (rng() - 0.5) * 40;
      t += Math.max(40, interval);
      f.keys.push({ seq: seq++, t, kind: 0, category: 0, trusted: 1 });
      f.inputs.push({ seq: seq++, t: t + 5, kind: 0, inputType: 0, trusted: 1 });
      f.keys.push({ seq: seq++, t: t + 60 + rng() * 70, kind: 1, category: 0, trusted: 1 });
    }
    t += 500;
    f.scrolls.push({ seq: seq++, dx: 0, dy: 12, t, trusted: 1, source: 0 });
  }
  return f;
}

/** Agente: ratón de metrónomo (16ms exactos) pero teclado humanizado. */
function roboticMouseHumanKeys(): Fixture {
  const rng = lcg(0x5eed);
  const f = fixture();
  for (let i = 0; i < 30; i += 1) {
    f.points.push({
      seq: i,
      x: 100 + i * 3,
      y: 200,
      t: 1000 + i * 16,
      kind: 0,
      pointerType: 0,
      trusted: 1,
    });
  }
  let t = 1000;
  for (let i = 0; i < 30; i += 1) {
    t += Math.max(40, 120 + (rng() - 0.5) * 90 + (rng() < 0.1 ? 300 * rng() : 0));
    f.keys.push({ seq: 100 + i, t, kind: 0, category: 0, trusted: 1 });
  }
  return f;
}

/** Eventos inyectados por código: trusted=0, holds de 0ms y ritmo idéntico. */
function injectedStream(): Fixture {
  const f = fixture();
  for (let i = 0; i < 20; i += 1) {
    f.keys.push({ seq: i, t: 1000 + i * 10, kind: 0, trusted: 0 });
    f.keys.push({ seq: 100 + i, t: 1000 + i * 10, kind: 1, trusted: 0 });
    f.inputs.push({ seq: 200 + i, t: 1000 + i * 10, trusted: 0 });
  }
  for (let i = 0; i < 20; i += 1) {
    f.points.push({
      seq: 300 + i,
      x: 100,
      y: 200,
      t: 1000 + i * 10,
      kind: 0,
      pointerType: 0,
      trusted: 0,
    });
  }
  return f;
}

/** Headless: webdriver + UA de herramientas + viewport por defecto + solo teclado. */
function headlessSession(): Fixture {
  const f = fixture();
  // 40 marcas con spanning > 1000ms para activar también "noMovement".
  f.keys = series(40, 1000, 30).map((t, i) => ({ seq: i, t, kind: 0, category: 0, trusted: 1 }));
  return f;
}
const HEADLESS_HINTS: EnvironmentHints = {
  webdriver: true,
  maxTouchPoints: 0,
  mobile: false,
  screenWidth: 800,
  screenHeight: 600,
  userAgent: "HeadlessChrome/120 Selenium/4 Puppeteer/20",
};
const HUMAN_HINTS: EnvironmentHints = {
  webdriver: false,
  maxTouchPoints: 1,
  mobile: false,
  screenWidth: 1920,
  screenHeight: 1080,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
};

/** Bot humanizado con jitter en diente de sierra (periodo 4). */
function sawtoothKeys(count = 40): KeySample[] {
  let t = 1000;
  return Array.from({ length: count }, (_, i) => {
    const sample = key(t, 0);
    t += 100 + (i % 4) * 10; // 100,110,120,130,100,...
    return sample;
  });
}

/** Bot humanizado con RNG uniforme de banda estrecha: 100 + Math.random()*20. */
function narrowUniformKeys(count = 40): KeySample[] {
  const rng = lcg(0x1234);
  let t = 1000;
  return Array.from({ length: count }, () => {
    const sample = key(t, 0);
    t += 100 + rng() * 20;
    return sample;
  });
}

function uniformRng(count = 60): number[] {
  const rng = lcg(0xabc123);
  return Array.from({ length: count }, () => 50 + rng() * 100);
}
function correlatedHumanJitter(count = 60): number[] {
  const rng = lcg(0x5eed);
  let value = 120;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    value = 0.75 * value + 0.25 * 120 + (rng() - 0.5) * 30;
    if (rng() < 0.1) value += 100 + rng() * 150;
    out.push(Math.max(30, value));
  }
  return out;
}

function cloneReplay(input: ReplayInput): ReplayInput {
  return {
    points: input.points.map((s) => ({ ...s })),
    clicks: input.clicks.map((s) => ({ ...s })),
    scrolls: input.scrolls.map((s) => ({ ...s })),
    keys: input.keys.map((s) => ({ ...s })),
    inputs: input.inputs.map((s) => ({ ...s })),
  };
}
function gesture(seed: number): ReplayInput {
  const f = humanSession(seed);
  return { points: f.points, clicks: f.clicks, scrolls: f.scrolls, keys: f.keys, inputs: f.inputs };
}

const detailed = (f: Fixture) => evaluateCoherenceDetailed(f);
const environment = (f: Fixture, hints?: EnvironmentHints) =>
  evaluateEnvironment({ ...f, ...(hints === undefined ? {} : { hints }) });
const coherence = (f: Fixture) =>
  evaluateCoherence(f.points, f.clicks, f.scrolls, f.keys, f.inputs);

// ===========================================================================
// L137-L154 — coherencia entre señales + señales del entorno
// ===========================================================================

describe("coherencia entre señales — escenarios reales", () => {
  it("L137 ratón + teclado: humano no sincroniza; agente escribe a 5ms del puntero", () => {
    const human = detailed(humanSession()).mouseKeyboardOverlap;
    const agent = fixture();
    agent.keys = series(12, 1000, 100).map((t) => key(t));
    agent.points = series(12, 1000, 100).map((t) => point(t));
    const robotic = detailed(agent).mouseKeyboardOverlap;
    expectUnit(human, "L137 humano");
    expect(human).toBe(0);
    expectFires(robotic, "L137 agente", 0.9);
  });

  it("L138 clic antes de escribir: humano enfoca, bot escribe sin clic", () => {
    const human = detailed(humanSession()).clickBeforeTyping;
    const agent = fixture();
    agent.keys = series(12, 1000, 100).map((t) => key(t));
    expectUnit(human, "L138 humano");
    expect(human).toBe(0);
    expectFires(detailed(agent).clickBeforeTyping, "L138 bot", 0.9);
  });

  it("L139 mirar antes de actuar: humano mueve el cursor, bot clic sin puntero", () => {
    const human = detailed(humanSession()).pointerBeforeAction;
    const agent = fixture();
    agent.clicks = series(10, 1000, 100).map((t) => click(t));
    expectUnit(human, "L139 humano");
    expect(human).toBe(0);
    expectFires(detailed(agent).pointerBeforeAction, "L139 bot", 0.9);
  });

  it("L140 congruencia de velocidades: ratón de máquina + teclado humano -> mezcla", () => {
    const mixed = roboticMouseHumanKeys();
    const score = coherence(mixed).mixedSuspicious;
    expectUnit(score, "L140");
    expectFires(score, "L140 mezcla", 0.9);
  });

  it("L141 mezcla sospechosa: humano coherente no acusa; la mezcla sí", () => {
    const human = coherence(humanSession()).mixedSuspicious;
    const mixed = coherence(roboticMouseHumanKeys()).mixedSuspicious;
    expectUnit(human, "L141 humano");
    expect(human).toBe(0);
    expectFires(mixed, "L141 mezcla", 0.9);
  });

  it("L142 consistencia temporal: humano estable; bot cambia de personalidad", () => {
    const human = detailed(humanSession()).temporalConsistency;
    const agent = fixture();
    agent.keys = [...series(5, 100, 50), 1000, 1137, 1426, 2048, 2948].map((t) => key(t));
    expectUnit(human, "L142 humano");
    expect(human).toBe(0);
    expectFires(detailed(agent).temporalConsistency, "L142 bot", 0.9);
  });

  it("L143 variedad: humano varía los intervalos; bot repite el retardo", () => {
    const human = detailed(humanSession()).sessionVariety;
    const agent = fixture();
    agent.keys = series(10, 100, 50).map((t) => key(t));
    expectUnit(human, "L143 humano");
    expect(human).toBe(0);
    expectFires(detailed(agent).sessionVariety, "L143 bot", 0.9);
  });

  it("L144 orden natural: humano down->up; bot solo eventos up", () => {
    const human = detailed(humanSession()).actionOrder;
    const agent = fixture();
    agent.keys = series(10, 100, 50).map((t) => key(t, 1));
    expectUnit(human, "L144 humano");
    expect(human).toBe(0);
    expectFires(detailed(agent).actionOrder, "L144 bot", 0.9);
  });

  it("L145 acciones sin evento previo: humano explicado; clics huérfanos del bot", () => {
    const human = coherence(humanSession()).actionsWithoutPriorEvent;
    const agent = fixture();
    agent.clicks = series(8, 1000, 2000).map((t) => click(t));
    expectUnit(human, "L145 humano");
    expect(human).toBe(0);
    expectFires(coherence(agent).actionsWithoutPriorEvent, "L145 bot", 0.9);
  });

  it("L146 eventos fantasma: humano con puntero; clics sin movimiento previo", () => {
    const human = coherence(humanSession()).phantomEvents;
    const agent = fixture();
    agent.clicks = series(8, 1000, 2000).map((t) => click(t));
    expectUnit(human, "L146 humano");
    expect(human).toBe(0);
    expectFires(coherence(agent).phantomEvents, "L146 bot", 0.9);
  });
});

describe("señales del entorno — escenarios reales", () => {
  it("L148 marca de navegador automatizado: humano 0; headless con webdriver 1", () => {
    const human = environment(humanSession(), HUMAN_HINTS).automatedBrowser;
    const bot = environment(headlessSession(), HEADLESS_HINTS).automatedBrowser;
    expect(human).toBe(0);
    expectFires(bot, "L148 headless", 0.9);
  });

  it("L149 eventos creados por código: humano 0; flujo inyectado 1", () => {
    const human = injectionRisk(humanSession().keys, humanSession().inputs, humanSession().points);
    const injected = injectedStream();
    const bot = injectionRisk(injected.keys, injected.inputs, injected.points);
    expect(human).toBe(0);
    expectFires(bot, "L149 inyectado", 0.9);
  });

  it("L150 dispositivo declarado vs comportamiento: coincidente 0; contradicción 1", () => {
    const h = humanSession();
    const ok = declaredVsBehavior("desktop", h.points, h.keys, h.inputs);
    const contradiction = declaredVsBehavior("touch", h.points, h.keys, h.inputs);
    expect(ok).toBe(0);
    expect(contradiction).toBe(1);
    expect(inferDeviceProfile(h.points, h.keys, h.inputs)).toBe("desktop");
  });

  it("L151 viewport raro: humano 1920x1080 -> 0; headless 800x600 -> 1", () => {
    expect(environment(fixture(), HUMAN_HINTS).oddViewport).toBe(0);
    expectFires(environment(fixture(), HEADLESS_HINTS).oddViewport, "L151", 0.9);
  });

  it("L152 falta de movimiento: humano con puntero 0; sesión larga solo teclado 1", () => {
    const h = humanSession();
    expect(environment(h, HUMAN_HINTS).noMovement).toBe(0);
    expectFires(environment(headlessSession(), HEADLESS_HINTS).noMovement, "L152", 0.9);
  });

  it("L153 falta de eventos normales: humano 5 flujos 0; headless 1 flujo 1", () => {
    expect(environment(humanSession(), HUMAN_HINTS).noNormalEvents).toBe(0);
    expectFires(environment(headlessSession(), HEADLESS_HINTS).noNormalEvents, "L153", 0.9);
  });

  it("L154 herramientas de agente: UA humano 0; UA con Selenium/Puppeteer 1", () => {
    expect(environment(fixture(), HUMAN_HINTS).agentTools).toBe(0);
    expectFires(environment(fixture(), HEADLESS_HINTS).agentTools, "L154", 0.9);
  });

  it("perfil headless completo: todas las señales de entorno explotan a la vez", () => {
    const signals = environment(headlessSession(), HEADLESS_HINTS);
    expectAllUnit(signals, "entorno headless");
    expect(signals.automatedBrowser).toBe(1);
    expect(signals.oddViewport).toBe(1);
    expect(signals.noMovement).toBe(1);
    expect(signals.noNormalEvents).toBe(1);
    expect(signals.agentTools).toBe(1);
  });
});

// ===========================================================================
// L210-L217 — resistencia a trampas
// ===========================================================================

describe("anti-trampas — escenarios reales", () => {
  it("L210 pesos aleatorizados por sesión sin alterar el modo por defecto", () => {
    const base = new ScoreComputer();
    expect(base.getEffectiveWeights()).toEqual(SIGNAL_WEIGHTS); // default intacto
    const a = new ScoreComputer();
    a.configure({ jitterSeed: 1111 });
    const b = new ScoreComputer();
    b.configure({ jitterSeed: 9999 });
    const wa = a.getEffectiveWeights();
    const wb = b.getEffectiveWeights();
    expect(wa).not.toEqual(wb);
    const aAgain = new ScoreComputer();
    aAgain.configure({ jitterSeed: 1111 });
    expect(aAgain.getEffectiveWeights()).toEqual(wa); // determinista por semilla
    for (const value of Object.values(wa)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("L211 chequeo sorpresa: scores derivados de muestras reales, contradicción ratón/teclado", () => {
    const mixed = roboticMouseHumanKeys();
    const human = humanSession();
    const mouseScore = mouseIntervalRegularity(mixed.points); // ratón de máquina
    const keyboardScore = keyboardIntervalRegularity(mixed.keys); // teclado humano
    expectFires(mouseScore, "L211 mouseScore derivado", 0.9);
    expect(keyboardScore).toBe(0);
    expect(hasKeyboardEvidence(mixed.keys, [])).toBe(true);
    const check = surpriseCoherenceCheck({
      mouseScore,
      keyboardScore,
      clickScore: null,
      scrollScore: null,
      mouseEvidence: true,
      keyboardEvidence: true,
      clickEvidence: false,
      scrollEvidence: false,
    });
    expect(check.passed).toBe(false);
    expect(check.reason).toContain("mouse-keyboard");
    const coherent = surpriseCoherenceCheck({
      mouseScore: mouseIntervalRegularity(human.points),
      keyboardScore: keyboardIntervalRegularity(human.keys),
      clickScore: null,
      scrollScore: null,
      mouseEvidence: true,
      keyboardEvidence: true,
      clickEvidence: false,
      scrollEvidence: false,
    });
    expect(coherent.passed).toBe(true);
    expect(coherent.reason.length).toBeGreaterThan(0);
  });

  it("L212 integridad: entorno sano pasa; reloj alterado se informa (sin ofuscación)", () => {
    const healthy = verifyIntegrity();
    expect(healthy.ok).toBe(true);
    expect(healthy.checks.every((c) => c.ok)).toBe(true);
    const entry = new URL("../../src/core/tamper.ts", import.meta.url).href;
    const code = [
      "globalThis.performance = { now: () => Number.NaN };",
      "globalThis.Date.now = () => Number.NaN;",
      `const { verifyIntegrity, integrityFingerprint } = await import(${JSON.stringify(entry)});`,
      "const report = verifyIntegrity();",
      "process.stdout.write(JSON.stringify({ ok: report.ok, clock: report.checks.find((c) => c.name === 'clock-usable').ok, fp: integrityFingerprint() }));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(out.ok).toBe(false);
    expect(out.clock).toBe(false);
    expect(out.fp).toMatch(/^[0-9a-f]{8}$/);
    expect(integrityFingerprint()).toBe(out.fp);
  });

  it("L213 eventos inyectados: metrónomo con holds de 0ms dispara riesgo alto", () => {
    const human = injectionRisk(humanSession().keys, humanSession().inputs, humanSession().points);
    const injected = injectedStream();
    const risk = injectionRisk(injected.keys, injected.inputs, injected.points);
    expect(human).toBe(0);
    expectFires(risk, "L213", 0.9);
  });

  it("L214 replay: misma escena repetida -> 1; escena nueva -> bajo; tracker lo detecta", () => {
    const first = gesture(0xa11ce);
    const identical = detectReplay(first, cloneReplay(first));
    expectAllUnit(identical, "L214 idéntica");
    expect(identical.repeatedPath).toBe(1);
    expect(identical.repeatedTiming).toBe(1);
    expect(identical.identicalSequence).toBe(1);
    // Un humano distinto: otro dispositivo (táctil), otra cadencia, otros
    // atributos y otros flujos presentes; NO es la misma escena repetida.
    const otherHuman: ReplayInput = {
      points: series(24, 1000, 45).map((t, i) => ({
        seq: i,
        x: 900 + i * 2,
        y: 700,
        t,
        kind: 0,
        pointerType: 2,
        trusted: 1,
      })),
      clicks: series(12, 1100, 90).map((t, i) => ({
        seq: i,
        x: 900,
        y: 700,
        t,
        kind: (i % 2) as 0 | 1,
        button: 2,
        trusted: 1,
      })),
      scrolls: [],
      keys: series(24, 1000, 75).map((t, i) => ({
        seq: i,
        t,
        kind: 0,
        category: 5,
        trusted: 1,
      })),
      inputs: [],
    };
    const fresh = detectReplay(first, otherHuman);
    expectAllUnit(fresh, "L214 nueva");
    expect(fresh.identicalSequence).toBeLessThan(0.6);
    const tracker = new ReplayTracker({ historySize: 4 });
    tracker.push(first);
    tracker.push(gesture(0x5151));
    tracker.push(cloneReplay(first));
    expectFires(tracker.signals().identicalSequence, "L214 tracker", 0.9);
    tracker.reset();
    expect(tracker.signals().identicalSequence).toBe(0);
  });

  it("L215 humanización falsa: diente de sierra y RNG de banda estrecha -> alto", () => {
    const human = humanizationRisk(humanSession().keys, humanSession().inputs);
    const sawtooth = humanizationRisk(
      sawtoothKeys().map((s, i) => ({ ...s, seq: i })),
      [],
    );
    const narrow = humanizationRisk(narrowUniformKeys(), []);
    expect(human).toBe(0);
    expectFires(sawtooth, "L215 sierra", 0.9);
    // RNG uniforme de banda estrecha (100 + rand()*20) también se detecta.
    expectFires(narrow, "L215 uniforme estrecho", 0.7);
  });

  it("L216 ruido humano correlacionado vs RNG uniforme: dirección correcta", () => {
    const rng = noiseHumanity(uniformRng());
    const human = noiseHumanity(correlatedHumanJitter());
    expectUnit(rng, "L216 RNG");
    expectUnit(human, "L216 humano");
    expect(rng).toBeLessThan(0.25);
    expect(human).toBeGreaterThan(0.5);
  });

  it("L217 ritmo por fórmula: sierra/rampa metronómica -> 1; humano/RNG -> bajo", () => {
    const saw = formulaRhythm(downIntervals(sawtoothKeys()));
    const ramp = formulaRhythm(Array.from({ length: 48 }, (_, i) => 50 + i * 5));
    const rng = formulaRhythm(uniformRng());
    const human = humanSession();
    const humanRhythm = formulaRhythm(downIntervals(human.keys));
    expectFires(saw, "L217 sierra", 0.9);
    expectFires(ramp, "L217 rampa", 0.9);
    expectUnit(rng, "L217 RNG");
    expect(rng).toBeLessThan(0.4);
    expectUnit(humanRhythm, "L217 humano");
    expect(humanRhythm).toBeLessThan(0.5);
    expect(noiseHumanity(downIntervals(sawtoothKeys()))).toBe(0);
    expect(hasKeyboardEvidence(human.keys, human.inputs)).toBe(true);
  });
});

// ===========================================================================
// Transversales: fail-closed, números hostiles, SSR, complejidad
// ===========================================================================

describe("transversal: fail-closed y entradas hostiles", () => {
  it("evidencia insuficiente (1-3 muestras) no acusa en ninguna guardarraíl", () => {
    const tiny = fixture();
    tiny.points = [point(1000), point(1016), point(1032)];
    tiny.clicks = [click(1000)];
    tiny.keys = [key(1000, 0), key(1000, 1), key(1016, 0)];
    tiny.inputs = [input(1000)];
    expectAllUnit(coherence(tiny), "fail-closed coherence");
    expectAllUnit(detailed(tiny), "fail-closed detailed");
    expectAllUnit(environment(tiny), "fail-closed environment");
    expectUnit(injectionRisk(tiny.keys, tiny.inputs, tiny.points), "fail-closed injection");
    expectUnit(humanizationRisk(tiny.keys, tiny.inputs), "fail-closed humanization");
    expectUnit(formulaRhythm([100, 110, 120]), "fail-closed formula");
    expectUnit(noiseHumanity([100, 110, 120]), "fail-closed noise");
    expectUnit(detectReplay({ ...tiny }, { ...tiny }).identicalSequence, "fail-closed replay");
    expect(new LivenessMonitor().status(0)).toBe("idle");
    const surprise = surpriseCoherenceCheck({
      mouseScore: 0.9,
      keyboardScore: null,
      clickScore: null,
      scrollScore: null,
      mouseEvidence: true,
      keyboardEvidence: false,
      clickEvidence: false,
      scrollEvidence: false,
    });
    expect(surprise.passed).toBe(true);
  });

  it("NaN/Infinity/1e308/negativos nunca lanzan ni generan acusaciones falsas", () => {
    const bad = fixture();
    bad.points = [
      point(NaN),
      point(Infinity),
      point(-Infinity),
      point(-500),
      point(1e308),
      point(-1e308),
      point(0),
    ];
    bad.clicks = [click(NaN), click(-100), click(1e308), click(Infinity)];
    bad.scrolls = [scroll(NaN), scroll(-1), scroll(1e308)];
    bad.keys = [key(NaN), key(Infinity), key(-Infinity), key(-100), key(1e308)];
    bad.inputs = [input(NaN), input(-1), input(1e308)];
    expectAllUnit(coherence(bad), "hostil coherence");
    expectAllUnit(detailed(bad), "hostil detailed");
    expectAllUnit(detailed({ ...bad, now: NaN }), "hostil horizonte");
    expectAllUnit(
      environment(bad, {
        webdriver: "yes" as unknown as boolean,
        maxTouchPoints: NaN,
        screenWidth: Infinity,
        screenHeight: -Infinity,
        mobile: 1 as unknown as boolean,
        userAgent: null as unknown as string,
      }),
      "hostil environment",
    );
    expectUnit(injectionRisk(bad.keys, bad.inputs, bad.points), "hostil injection");
    expectUnit(humanizationRisk(bad.keys, bad.inputs), "hostil humanization");
    expectUnit(
      formulaRhythm([NaN, Infinity, -Infinity, -100, 0, 1e308, 10, 20, 30]),
      "hostil formula",
    );
    expectUnit(noiseHumanity([NaN, Infinity, -100, 0, 1e308, 10, 20, 30]), "hostil noise");
    expectAllUnit(detectReplay({ ...bad }, { ...bad }), "hostil replay");
    const weird: EnvironmentHints = { screenWidth: -1, screenHeight: -1 };
    expectUnit(environment(fixture(), weird).oddViewport, "hostil viewport");
    expect(new LivenessMonitor({ intervalMs: NaN, staleMs: Infinity }).status(0)).toBe("idle");
  });
});

describe("transversal: SSR sin DOM", () => {
  it("los ocho módulos cargan y devuelven valores finitos sin window/document/navigator", () => {
    const base = "../../src/core/";
    const modules = [
      "coherence",
      "environment",
      "injection",
      "replay",
      "tamper",
      "liveness",
      "surprise",
      "noise",
    ];
    const imports = modules
      .map((name) => {
        const url = new URL(`${base}${name}.ts`, import.meta.url).href;
        return `${name}: await import(${JSON.stringify(url)}),`;
      })
      .join("\n");
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      "const m = {",
      imports,
      "};",
      "const empty = { points: [], clicks: [], scrolls: [], keys: [], inputs: [] };",
      "const out = {",
      "  coherence: m.coherence.evaluateCoherenceDetailed(empty),",
      "  environment: m.environment.evaluateEnvironment(empty),",
      "  injection: m.injection.injectionRisk([], [], []),",
      "  humanization: m.injection.humanizationRisk([], []),",
      "  replay: m.replay.detectReplay(empty, empty),",
      "  integrity: m.tamper.verifyIntegrity().ok,",
      "  liveness: new m.liveness.LivenessMonitor().status(0),",
      "  surprise: m.surprise.surpriseCoherenceCheck({ mouseScore: null, keyboardScore: null, clickScore: null, scrollScore: null, mouseEvidence: false, keyboardEvidence: false, clickEvidence: false, scrollEvidence: false }).passed,",
      "  noise: m.noise.noiseHumanity([]),",
      "};",
      "const allZero = Object.values(out.coherence).every((v) => v === 0) && Object.values(out.environment).every((v) => v === 0) && Object.values(out.replay).every((v) => v === 0);",
      "if (!allZero || out.injection !== 0 || out.humanization !== 0 || out.noise !== 0) process.exit(4);",
      "if (out.liveness !== 'idle' || out.surprise !== true || typeof out.integrity !== 'boolean') process.exit(5);",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(result.stdout));
    expectAllUnit(out.coherence, "SSR coherence");
    expectAllUnit(out.environment, "SSR environment");
    expectAllUnit(out.replay, "SSR replay");
    expect(out.integrity).toBe(true);
    expect(out.liveness).toBe("idle");
    expect(out.surprise).toBe(true);
  });
});

describe("transversal: complejidad en sesión grande", () => {
  it("O(n log n): 30k eventos se procesan rápido y sin desbordar la pila", () => {
    const f = fixture();
    const n = 30_000;
    const rng = lcg(0xbeef);
    for (let i = 0; i < n; i += 1) {
      f.points.push({
        seq: i,
        x: rng() * 1200,
        y: rng() * 800,
        t: 1000 + i * 20 + rng() * 18,
        kind: 0,
        pointerType: 0,
        trusted: 1,
      });
      f.keys.push({ seq: i, t: 1000 + i * 22 + rng() * 20, kind: 0, category: 0, trusted: 1 });
    }
    const started = performance.now();
    expectAllUnit(coherence(f), "grande coherence");
    expectAllUnit(detailed(f), "grande detailed");
    expectAllUnit(environment(f, HUMAN_HINTS), "grande environment");
    expectUnit(injectionRisk(f.keys, f.inputs, f.points), "grande injection");
    expectUnit(humanizationRisk(f.keys, f.inputs), "grande humanization");
    expectUnit(formulaRhythm(downIntervals(f.keys)), "grande formula");
    expectUnit(noiseHumanity(downIntervals(f.keys)), "grande noise");
    const replay: ReplayInput = { ...f };
    expectAllUnit(detectReplay(replay, cloneReplay(replay)), "grande replay");
    const tracker = new ReplayTracker({ historySize: 2 });
    tracker.push(replay);
    tracker.push(replay);
    expectAllUnit(tracker.signals(), "grande tracker");
    const elapsed = performance.now() - started;
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});
