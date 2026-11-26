// Etapa 8 — laboratorio: perfiles deterministas para la tabla honesta.
//
// SOLO números: x/y/t, duraciones, conteos y categorías. Nunca teclas, texto,
// red, storage ni DOM. Ningún generador externo: el PRNG es un LCG de 5 líneas
// (semilla fija) para que cada perfil sea reproducible sin dependencias.
//
// ETIQUETA DE ORIGEN (obligatoria en todo perfil):
// - SIMULATED: sintético, escrito aquí. NO es una sesión de un agente real.
// - REAL-DERIVED: volcado numérico de la sesión humana grabada
//   `calibracion-teclado(1).json` (ver tests/human-typing-calibration.test.ts y
//   src/calibration/human-typing.ts). Sin teclas ni texto, solo [t, kind, cat].

import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/index";
import {
  AGENT_KEYBOARD_REFERENCE,
  AI_MIN,
  HUMAN_MAX,
  HUMAN_TYPING_BASELINE,
  ScoreComputer,
} from "../src/index";

export type Provenance = "SIMULATED" | "REAL-DERIVED";

export interface LabProfile {
  id: string;
  /** Nombre legible; SIEMPRE empieza con [SIMULATED] o [REAL-DERIVED]. */
  label: string;
  provenance: Provenance;
  /** Humano o agente, según la etiqueta de origen de la sesión. */
  truth: "human" | "agent";
  /** Limitación honesta de este perfil, en español. */
  note: string;
  mouse: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
}

/** Generador lineal congruencial, sin dependencias ni Math.random. */
export function makeRand(initial: number): () => number {
  let seed = initial >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

const MOUSE_KIND = 0 as const;
const MOUSE_TYPE = 0 as const;
const INPUT_KIND = 0 as const;

// ---------------------------------------------------------------------------
// (a) Humano simulado: trackpad/ratón con jitter, campana de velocidad y pausas
// ---------------------------------------------------------------------------

/** Trayectoria con jitter subpíxel correlacionado, velocidad en campana y pausas. */
export function humanMouse(count = 48, seed = 0x5eed): PointerSample[] {
  const rand = makeRand(seed);
  const out: PointerSample[] = [];
  let x = 120.25;
  let y = 240.5;
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    const phase = count > 1 ? i / (count - 1) : 0;
    const bell = Math.sin(Math.PI * phase);
    const pause = i % 11 === 5 ? 210 : 0;
    const dt = 16 + Math.round((1 - bell) * 110) + Math.floor(rand() * 34) + pause;
    // Jitter suave: dos sinusoides lentas + ruido pequeño, sin giros bruscos.
    const wiggle = Math.sin(i * 0.45) * 1.6 + Math.sin(i * 0.17) * 2.3 + (rand() - 0.5) * 0.9;
    x += 5.4 + 5 * bell + (rand() - 0.5) * 2.2 + wiggle * 0.22;
    y += wiggle;
    t += dt;
    out.push({
      seq: i + 1,
      x,
      y,
      t,
      kind: MOUSE_KIND,
      pointerType: MOUSE_TYPE,
      trusted: 1,
    });
  }
  return out;
}

/** 12 clics: duración 60-180ms, intervalo 120-520ms, puntería variable. */
export function humanClicks(count = 12, seed = 12345): ClickSample[] {
  const rand = makeRand(seed);
  const out: ClickSample[] = [];
  let t = 0;
  let seq = 1;
  for (let i = 0; i < count; i += 1) {
    const duration = 60 + Math.floor(rand() * 121);
    const x = 100 + i * 37 + rand() * 20;
    const y = 50 + (i % 4) * 60 + rand() * 15;
    out.push({ seq: seq++, x, y, t, kind: 0, button: 0, trusted: 1 });
    out.push({ seq: seq++, x, y, t: t + duration, kind: 1, button: 0, trusted: 1 });
    t += 120 + Math.floor(rand() * 401);
  }
  return out;
}

/** 16 wheel: deltas 80-120, delays 30-120ms, reversiones y pausas humanas. */
export function humanScrolls(count = 16, seed = 54321): ScrollSample[] {
  const rand = makeRand(seed);
  const out: ScrollSample[] = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    const delta = 80 + Math.floor(rand() * 41);
    const sign = i % 5 === 4 ? -1 : 1;
    out.push({ seq: i + 1, dx: 0, dy: sign * delta, t, trusted: 1, source: 0 });
    t += 30 + Math.floor(rand() * 91) + (i % 6 === 0 ? 400 : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// (b) Bot naive: línea recta, cadencia fija y teletransporte al hacer clic
// ---------------------------------------------------------------------------

/** Pocos pasos rectos a 16ms y un salto grande en el instante del clic. */
export function naiveBotMouse(moves = 30): PointerSample[] {
  const out: PointerSample[] = [];
  for (let i = 0; i < moves; i += 1) {
    out.push({
      seq: out.length + 1,
      x: 100 + i * 8,
      y: 200 + i * 3,
      t: i * 16,
      kind: MOUSE_KIND,
      pointerType: MOUSE_TYPE,
      trusted: 0,
    });
  }
  // Un agente que no emite mousemove continuo: salta al destino del clic.
  out.push({
    seq: out.length + 1,
    x: 700.5,
    y: 500.25,
    t: moves * 16,
    kind: MOUSE_KIND,
    pointerType: MOUSE_TYPE,
    trusted: 0,
  });
  return out;
}

/** Clics a 100ms exactos, siempre el mismo punto y duración fija. */
export function naiveBotClicks(count = 12): ClickSample[] {
  const out: ClickSample[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      seq: out.length + 1,
      x: 700.5,
      y: 500.25,
      t: i * 100,
      kind: 0,
      button: 0,
      trusted: 0,
    });
    out.push({
      seq: out.length + 1,
      x: 700.5,
      y: 500.25,
      t: i * 100 + 60,
      kind: 1,
      button: 0,
      trusted: 0,
    });
  }
  return out;
}

/** Wheel robot: delta 100 y cadencia 60ms exactos, sin reversiones ni pausas. */
export function naiveBotScrolls(count = 16): ScrollSample[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    dx: 0,
    dy: 100,
    t: i * 60,
    trusted: 0,
    source: 0,
  }));
}

/**
 * Teclado de agente sin disfrazar: IKI fija de 7ms (entre los 5.31ms de
 * Browser Use y los 9.52ms de Skyvern citados en external-reference) y holds
 * de 10ms, que es el artefacto típico de CDP/Playwright `delay: 0`.
 */
export function naiveBotKeyboard(count = 40, ikiMs = 7, holdMs = 10): KeySample[] {
  const out: KeySample[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      seq: out.length + 1,
      t: i * ikiMs,
      kind: 0,
      category: 0,
      trusted: 0,
    });
    out.push({
      seq: out.length + 1,
      t: i * ikiMs + holdMs,
      kind: 1,
      category: 0,
      trusted: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) Agente humanizado: jitter y pausas, pero sigue siendo sintético
// ---------------------------------------------------------------------------

/** Jitter determinista de ciclo corto: se mueve, pero con patrones repetidos. */
export function humanizedAgentMouse(count = 24): PointerSample[] {
  const dts = [24, 47, 91, 38, 130];
  const wiggles = [1.2, -0.8, 2.1, -1.6, 0.6];
  const out: PointerSample[] = [];
  let x = 60.5;
  let y = 90.25;
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    t += dts[i % dts.length] + (i % 7 === 3 ? 180 : 0);
    x += 9 + wiggles[i % wiggles.length] * 0.3;
    y += wiggles[i % wiggles.length];
    out.push({
      seq: i + 1,
      x,
      y,
      t,
      kind: MOUSE_KIND,
      pointerType: MOUSE_TYPE,
      trusted: 0,
    });
  }
  return out;
}

/** Clics jitterizados: 4 intervalos y 3 puntos fijos; parece humano, no lo es. */
export function humanizedAgentClicks(count = 12): ClickSample[] {
  const intervals = [130, 240, 180, 310];
  const targets = [
    { x: 300.25, y: 210.5 },
    { x: 340.75, y: 245.25 },
    { x: 315.5, y: 230.75 },
  ];
  const out: ClickSample[] = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    const target = targets[i % targets.length];
    const duration = 70 + ((i * 37) % 90);
    out.push({
      seq: out.length + 1,
      x: target.x,
      y: target.y,
      t,
      kind: 0,
      button: 0,
      trusted: 0,
    });
    out.push({
      seq: out.length + 1,
      x: target.x,
      y: target.y,
      t: t + duration,
      kind: 1,
      button: 0,
      trusted: 0,
    });
    t += intervals[i % intervals.length] + (i % 5 === 2 ? 190 : 0);
  }
  return out;
}

/** Wheel con ciclo corto de deltas y reversiones: imita al anti-detector. */
export function humanizedAgentScrolls(count = 16): ScrollSample[] {
  const deltas = [83, 117, 96, 104, 89];
  const intervals = [28, 95, 42, 240, 61, 275];
  const out: ScrollSample[] = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    const sign = i % 4 === 2 ? -1 : 1;
    out.push({
      seq: i + 1,
      dx: 0,
      dy: sign * deltas[i % deltas.length],
      t,
      trusted: 0,
      source: 0,
    });
    t += intervals[i % intervals.length];
  }
  return out;
}

/**
 * Teclado humanizado: cadencia humana (ciclo de 5 IKIs + pausa), pero holds
 * cortos de agente (12ms). Rompe `exactRhythm` y `intervalRegularity`, y por
 * eso puede NO ser detectado: se reporta tal cual, sin reclamar éxito.
 */
export function humanizedAgentKeyboard(count = 30): KeySample[] {
  const intervals = [130, 190, 260, 175, 220];
  const out: KeySample[] = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    out.push({ seq: out.length + 1, t, kind: 0, category: 0, trusted: 0 });
    out.push({ seq: out.length + 1, t: t + 12, kind: 1, category: 0, trusted: 0 });
    t += intervals[i % intervals.length] + (i % 9 === 4 ? 1100 : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// (d) Sesión humana REAL grabada y su replay idéntico (REAL-DERIVED)
// ---------------------------------------------------------------------------

/**
 * Volcado numérico de `calibracion-teclado(1).json`, 2026-11-26T07:52:03.404Z.
 * Copiado de tests/human-typing-calibration.test.ts (la sesión etiquetada
 * "humano", HUMAN_TYPING_BASELINE). Solo [t, kind, category]: sin teclas/texto.
 */
const RECORDED_KEY_TUPLES: Array<[number, 0 | 1, number]> = [
  [35716, 0, 2],
  [35810, 1, 2],
  [35825, 0, 0],
  [35935, 1, 0],
  [35997, 0, 0],
  [36108, 1, 0],
  [36263, 0, 0],
  [36372, 1, 0],
  [36544, 0, 0],
  [36638, 1, 0],
  [36778, 0, 0],
  [36872, 1, 0],
  [36967, 0, 2],
  [37028, 1, 2],
  [37216, 0, 0],
  [37294, 1, 0],
  [37310, 0, 0],
  [37436, 1, 0],
  [37497, 0, 0],
  [37544, 1, 0],
  [37747, 0, 0],
  [37810, 0, 0],
  [37826, 1, 0],
  [37889, 1, 0],
  [37919, 0, 2],
  [38028, 1, 2],
  [38169, 0, 0],
  [38233, 1, 0],
  [38263, 0, 0],
  [38373, 1, 0],
  [38435, 0, 0],
  [38529, 0, 2],
  [38544, 1, 0],
  [38622, 1, 2],
  [38779, 0, 0],
  [38825, 1, 0],
  [38935, 0, 0],
  [38997, 0, 0],
  [39014, 1, 0],
  [39107, 1, 0],
  [39216, 0, 0],
  [39358, 1, 0],
  [39451, 0, 0],
  [39560, 1, 0],
  [39950, 0, 7],
  [40075, 1, 7],
  [46763, 0, 6],
  [47013, 0, 0],
  [47107, 1, 0],
  [47186, 1, 6],
  [48013, 0, 6],
  [48326, 0, 0],
  [48450, 1, 0],
  [48513, 1, 6],
];

/** Solo [t, inputType]; 23 escritas + 1 pegado, sin contenido. */
const RECORDED_INPUT_TUPLES: Array<[number, 0 | 1]> = [
  [35723, 0],
  [35831, 0],
  [36005, 0],
  [36278, 0],
  [36561, 0],
  [36785, 0],
  [36976, 0],
  [37225, 0],
  [37314, 0],
  [37502, 0],
  [37749, 0],
  [37818, 0],
  [37932, 0],
  [38183, 0],
  [38271, 0],
  [38378, 0],
  [38538, 0],
  [38781, 0],
  [38949, 0],
  [39014, 0],
  [39220, 0],
  [39457, 0],
  [39966, 0],
  [48344, 1],
];

function recordedKeys(): KeySample[] {
  return RECORDED_KEY_TUPLES.map(([t, kind, category], i) => ({
    seq: i + 1,
    t,
    kind,
    category: category as KeySample["category"],
    trusted: 1,
  }));
}

function recordedInputs(): InputSample[] {
  return RECORDED_INPUT_TUPLES.map(([t, inputType], i) => ({
    seq: i + 1,
    t,
    kind: INPUT_KIND,
    inputType: inputType as InputSample["inputType"],
    trusted: 1,
  }));
}

/** La misma sesión real repetida dos veces con desplazamiento constante. */
export function replayRecordedHumanKeyboard(): { keys: KeySample[]; inputs: InputSample[] } {
  const keys = recordedKeys();
  const inputs = recordedInputs();
  const shift = keys[keys.length - 1].t + 1000;
  const keysAgain = keys.map((sample) => ({
    ...sample,
    seq: sample.seq + keys.length,
    t: sample.t + shift,
  }));
  const inputsAgain = inputs.map((sample) => ({
    ...sample,
    seq: sample.seq + inputs.length,
    t: sample.t + shift,
  }));
  return { keys: [...keys, ...keysAgain], inputs: [...inputs, ...inputsAgain] };
}

// ---------------------------------------------------------------------------
// Catálogo y evaluación compartida (test y herramienta usan LA MISMA función)
// ---------------------------------------------------------------------------

const EMPTY = (): PointerSample[] => [];

function profile(
  id: string,
  label: string,
  provenance: Provenance,
  truth: "human" | "agent",
  note: string,
  data: {
    mouse?: PointerSample[];
    clicks?: ClickSample[];
    scrolls?: ScrollSample[];
    keys?: KeySample[];
    inputs?: InputSample[];
  },
): LabProfile {
  return {
    id,
    label: `[${provenance}] ${label}`,
    provenance,
    truth,
    note,
    mouse: data.mouse ?? EMPTY(),
    clicks: data.clicks ?? [],
    scrolls: data.scrolls ?? [],
    keys: data.keys ?? [],
    inputs: data.inputs ?? [],
  };
}

export const LAB_PROFILES: LabProfile[] = [
  profile(
    "human-mouse",
    "humano trackpad/ratón",
    "SIMULATED",
    "human",
    "Jitter sintetizado con sinusoides: no es un trackpad real, solo imita su campana de velocidad y sus pausas.",
    { mouse: humanMouse() },
  ),
  profile(
    "human-clicks-scrolls",
    "humano clics+scroll",
    "SIMULATED",
    "human",
    "Deltas y delays muestreados con LCG: imitan la sesión E2E, no son eventos grabados.",
    { clicks: humanClicks(), scrolls: humanScrolls() },
  ),
  profile(
    "human-keyboard-recorded",
    "humano teclado",
    "REAL-DERIVED",
    "human",
    `Sesión real del ${HUMAN_TYPING_BASELINE.recordedAt.slice(0, 10)}: mediana IKI ${HUMAN_TYPING_BASELINE.interKeyDownMs.p50}ms, hold ${HUMAN_TYPING_BASELINE.keyHoldMs.p50}ms. Una sola sesión, no una población.`,
    { keys: recordedKeys(), inputs: recordedInputs() },
  ),
  profile(
    "human-keyboard-replay",
    "humano teclado REPLAY x2",
    "REAL-DERIVED",
    "human",
    "La misma sesión grabada repetida dos veces: la librería actual NO compara entre sesiones, así que el replay puede pasar desapercibido.",
    replayRecordedHumanKeyboard(),
  ),
  profile(
    "naive-bot-combined",
    "bot naive mouse+clics+scroll",
    "SIMULATED",
    "agent",
    "Línea recta, 16ms fijos y salto al clic; clics y wheel a cadencia exacta. El mouse solo (≈0.30) queda en duda: la detección la dan clics+scroll y el global roza AI_MIN (0.58). NO es un agente real.",
    { mouse: naiveBotMouse(), clicks: naiveBotClicks(), scrolls: naiveBotScrolls() },
  ),
  profile(
    "naive-bot-keyboard",
    "bot naive teclado 7ms",
    "SIMULATED",
    "agent",
    `IKI fijo 7ms y hold 10ms, dentro de las referencias públicas (Browser Use ${AGENT_KEYBOARD_REFERENCE.interKeyMs["Browser Use"]}ms, Skyvern ${AGENT_KEYBOARD_REFERENCE.interKeyMs.Skyvern}ms, Manus ${AGENT_KEYBOARD_REFERENCE.interKeyMs.Manus}ms). Cadencia sintética, no traza de agente.`,
    { keys: naiveBotKeyboard() },
  ),
  profile(
    "humanized-agent-combined",
    "agente humanizado mouse+clics+scroll",
    "SIMULATED",
    "agent",
    "Jitter y pausas de ciclo corto: reduce todas las medidas, pero sigue siendo un guion determinista. Puede NO detectarse.",
    {
      mouse: humanizedAgentMouse(),
      clicks: humanizedAgentClicks(),
      scrolls: humanizedAgentScrolls(),
    },
  ),
  profile(
    "humanized-agent-keyboard",
    "agente humanizado teclado",
    "SIMULATED",
    "agent",
    "IKI jitterizado con pausa, pero holds de 12ms al estilo CDP. Al romper el ritmo exacto puede quedar por debajo de HUMAN_MAX: se reporta sin maquillar.",
    { keys: humanizedAgentKeyboard() },
  ),
];

export function profileById(id: string): LabProfile {
  const found = LAB_PROFILES.find((item) => item.id === id);
  if (!found) throw new Error(`Perfil de laboratorio desconocido: ${id}`);
  return found;
}

/** Ventana de mouse que el detector deriva de los propios timeStamp. */
export function mouseWindowMs(mouse: PointerSample[]): number {
  return mouse.length >= 2 ? mouse[mouse.length - 1].t - mouse[0].t : 0;
}

export type Band = "measuring" | "human" | "doubt" | "ai";

export interface LabRow {
  id: string;
  profile: string;
  provenance: Provenance;
  truth: LabProfile["truth"];
  /** Señales con evidencia suficiente, p. ej. "mouse+click+scroll". */
  signal: string;
  score: number | null;
  mouseScore: number | null;
  clickScore: number | null;
  scrollScore: number | null;
  keyboardScore: number | null;
  band: Band;
  /** true cuando el veredicto fue AGENTE (score >= AI_MIN). */
  detected: boolean;
  /** true cuando el veredicto coincidió con la etiqueta de origen. */
  correct: boolean;
  note: string;
}

/** Bandas oficiales del score: la franja intermedia es duda, no éxito. */
export function bandOf(score: number | null): Band {
  if (score === null) return "measuring";
  if (score <= HUMAN_MAX) return "human";
  if (score >= AI_MIN) return "ai";
  return "doubt";
}

/**
 * Evalúa un perfil con un ScoreComputer NUEVO (sin EMA heredado entre perfiles)
 * y devuelve la fila exacta que usan el test y el generador de LAB_REPORT.md.
 */
export function evaluateProfile(item: LabProfile): LabRow {
  const computer = new ScoreComputer();
  const evidence = computer.evaluate(
    item.mouse,
    mouseWindowMs(item.mouse),
    item.clicks,
    item.scrolls,
    item.keys,
    item.inputs,
  );
  const signalScores = computer.getSignalScores();
  const signal = (["mouse", "click", "scroll", "keyboard"] as const)
    .filter((name) => signalScores[name] !== null)
    .join("+");
  const band = bandOf(evidence.score);
  const detected = band === "ai";
  return {
    id: item.id,
    profile: item.label,
    provenance: item.provenance,
    truth: item.truth,
    signal: signal || "sin-evidencia",
    score: evidence.score,
    mouseScore: signalScores.mouse,
    clickScore: signalScores.click,
    scrollScore: signalScores.scroll,
    keyboardScore: signalScores.keyboard,
    band,
    detected,
    correct: item.truth === "human" ? !detected : detected,
    note: item.note,
  };
}

/** Todas las filas, en el orden del catálogo. */
export function evaluateAll(): LabRow[] {
  return LAB_PROFILES.map(evaluateProfile);
}
