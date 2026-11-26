// Etapa 8 — laboratorio honesto: matriz de veredictos sobre perfiles
// deterministas. Las bandas esperadas SON LAS MEDIDAS, no un deseo: el agente
// humanizado y el replay quedan sin detectar y así se afirman.
//
// Sin PRNG externo, sin red, sin storage y sin DOM al importar: los perfiles
// viven en ./lab-profiles.ts y la evaluación usa ScoreComputer (puro).

import { describe, expect, it } from "bun:test";
import { AI_MIN, HUMAN_MAX, IsThatAnAI } from "../src/index";
import type { LabProfile } from "./lab-profiles";
import { type Band, evaluateAll, LAB_PROFILES, profileById } from "./lab-profiles";

/** Banda, score medido y si el veredicto coincidió con la etiqueta de origen. */
const EXPECTED: Record<string, { band: Band; score: number; detected: boolean; correct: boolean }> =
  {
    "human-mouse": { band: "human", score: 0.158, detected: false, correct: true },
    "human-clicks-scrolls": { band: "human", score: 0.2199, detected: false, correct: true },
    "human-keyboard-recorded": { band: "human", score: 0.0448, detected: false, correct: true },
    "human-keyboard-replay": { band: "human", score: 0.1481, detected: false, correct: true },
    "naive-bot-combined": { band: "ai", score: 0.5813, detected: true, correct: true },
    "naive-bot-keyboard": { band: "ai", score: 0.7857, detected: true, correct: true },
    "humanized-agent-combined": { band: "human", score: 0.1369, detected: false, correct: false },
    "humanized-agent-keyboard": { band: "human", score: 0.1785, detected: false, correct: false },
  };

const fmt = (value: number | null): string => (value === null ? "-" : value.toFixed(4));

function compactTable(rows: ReturnType<typeof evaluateAll>): string {
  const head = ["perfil", "señal", "score", "veredicto", "detectado", "correcto"];
  const lines = [
    head,
    ...rows.map((row) => [
      row.id,
      row.signal,
      fmt(row.score),
      row.band,
      row.detected ? "si" : "no",
      row.correct ? "si" : "no",
    ]),
  ];
  const widths = head.map((_, i) => Math.max(...lines.map((line) => line[i].length)));
  return lines.map((line) => line.map((cell, i) => cell.padEnd(widths[i])).join(" | ")).join("\n");
}

// Evento sintético con propiedades definidas aunque sean getters de solo lectura.
function fakeEvent(type: string, props: Record<string, unknown>): Event {
  const result = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor && !descriptor.configurable) continue;
    Object.defineProperty(result, key, { value, configurable: true });
  }
  return result;
}

function fakeDom(): { target: EventTarget; restore: () => void } {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const target = new EventTarget();
  globals.window = target;
  globals.document = new EventTarget();
  return {
    target,
    restore: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    },
  };
}

interface ScheduledEvent {
  t: number;
  type: string;
  props: Record<string, unknown>;
}

/** Convierte un perfil en eventos del DOM, ordenados por timeStamp. */
function schedule(profile: LabProfile): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];
  for (const sample of profile.mouse) {
    events.push({
      t: sample.t,
      type: "pointermove",
      props: {
        clientX: sample.x,
        clientY: sample.y,
        timeStamp: sample.t,
        pointerType: "mouse",
        isTrusted: sample.trusted === 1,
      },
    });
  }
  for (const sample of profile.clicks) {
    events.push({
      t: sample.t,
      type: sample.kind === 0 ? "pointerdown" : "pointerup",
      props: {
        clientX: sample.x,
        clientY: sample.y,
        timeStamp: sample.t,
        button: sample.button,
        isTrusted: sample.trusted === 1,
      },
    });
  }
  for (const sample of profile.scrolls) {
    events.push({
      t: sample.t,
      type: "wheel",
      props: {
        deltaX: sample.dx,
        deltaY: sample.dy,
        deltaMode: 0,
        timeStamp: sample.t,
        isTrusted: sample.trusted === 1,
      },
    });
  }
  return events.sort((a, b) => a.t - b.t);
}

describe("Etapa 8 — matriz honesta del laboratorio", () => {
  it("cubre todos los perfiles con etiqueta de origen explícita", () => {
    expect(LAB_PROFILES).toHaveLength(Object.keys(EXPECTED).length);
    for (const item of LAB_PROFILES) {
      expect(item.label.startsWith(`[${item.provenance}]`)).toBe(true);
      expect(["SIMULATED", "REAL-DERIVED"]).toContain(item.provenance);
      expect(EXPECTED[item.id]).toBeDefined();
    }
  });

  it("bandas y scores medidos, sin reclamar detección no observada", () => {
    for (const row of evaluateAll()) {
      const expected = EXPECTED[row.id];
      expect(row.band).toBe(expected.band);
      expect(row.detected).toBe(expected.detected);
      expect(row.correct).toBe(expected.correct);
      expect(row.score as number).toBeCloseTo(expected.score, 2);
      if (row.band === "human") expect(row.score as number).toBeLessThanOrEqual(HUMAN_MAX);
      if (row.band === "ai") expect(row.score as number).toBeGreaterThanOrEqual(AI_MIN);
      if (row.band === "doubt") {
        expect(row.score as number).toBeGreaterThan(HUMAN_MAX);
        expect(row.score as number).toBeLessThan(AI_MIN);
      }
    }
  });

  it("imprime la tabla compacta", () => {
    const rows = evaluateAll();
    const table = compactTable(rows);
    console.log(`\nEtapa 8 — laboratorio (perfiles simulados; una sesión real derivada)\n${table}`);
    expect(table.trim().split("\n")).toHaveLength(rows.length + 1);
  });

  it("el bot naive SÍ se detecta; el humanizado y el replay NO", () => {
    const rows = evaluateAll();
    const byId = (id: string) => {
      const found = rows.find((row) => row.id === id);
      if (!found) throw new Error(`Sin fila para ${id}`);
      return found;
    };
    expect(byId("naive-bot-combined").detected).toBe(true);
    expect(byId("naive-bot-keyboard").detected).toBe(true);
    // Imperfección declarada: el agente disfrazado queda por debajo de HUMAN_MAX.
    expect(byId("humanized-agent-combined").correct).toBe(false);
    expect(byId("humanized-agent-keyboard").correct).toBe(false);
    // El replay de una sesión real tampoco se marca como replay: no existe esa señal.
    const replay = byId("human-keyboard-replay");
    expect(replay.detected).toBe(false);
    expect(replay.provenance).toBe("REAL-DERIVED");
    expect(replay.note).toContain("NO compara entre sesiones");
  });

  it("los perfiles son reproducibles y no contienen identidades de tecla", () => {
    const first = evaluateAll().map((row) => row.score);
    const second = evaluateAll().map((row) => row.score);
    expect(first).toEqual(second);
    const json = JSON.stringify(LAB_PROFILES);
    for (const identity of ["KeyA", "Enter", "Backspace", "hola", "password"]) {
      expect(json).not.toContain(identity);
    }
  });

  it("IsThatAnAI con now inyectado confirma el veredicto del bot naive", () => {
    const { target, restore } = fakeDom();
    let clock = 0;
    let detector: IsThatAnAI | null = null;
    try {
      detector = new IsThatAnAI({ now: () => clock });
      detector.start();
      const events = schedule(profileById("naive-bot-combined"));
      for (let i = 0; i < events.length; i += 1) {
        clock = events[i].t;
        target.dispatchEvent(fakeEvent(events[i].type, events[i].props));
        if ((i + 1) % 8 === 0) detector.evaluate();
      }
      detector.evaluate();
      expect(detector.getVerdict().state).toBe("ai");
      expect(detector.getVerdict().score as number).toBeGreaterThanOrEqual(AI_MIN);
      expect(detector.getSignalScores().mouse).not.toBeNull();
    } finally {
      detector?.stop();
      restore();
    }
  });
});
