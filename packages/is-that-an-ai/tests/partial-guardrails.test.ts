import { describe, expect, it } from "bun:test";
import { evaluateCoherence } from "../src/core/coherence";
import { declaredVsBehavior, humanizationRisk, injectionRisk } from "../src/core/injection";
import type {
  ClickSample,
  InputSample,
  KeyCategory,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";
import { PRIVACY_NOTICE, privacyAudit } from "../src/utils/privacy-audit";

// Muestras 100% numéricas y deterministas: ningún evento real, ningún DOM.
// El jitter "humano" es una serie fija con CV ~0.5 y 20/20 intervalos
// distintos; el ritmo "robótico" es un metrónomo de 60ms.

const HUMAN_DTS = [23, 61, 17, 88, 34, 52, 19, 74, 41, 29, 96, 38, 55, 22, 67, 45, 31, 83, 27, 58];

function timesFrom(dts: number[], start = 1000): number[] {
  const out = [start];
  let t = start;
  for (const dt of dts) {
    t += dt;
    out.push(t);
  }
  return out;
}

function humanPointers(): PointerSample[] {
  const times = timesFrom(HUMAN_DTS, 1000);
  return times.map((t, i) => ({
    seq: i + 1,
    x: 100 + ((i * 37) % 90) + (i % 3) / 10,
    y: 80 + ((i * 53) % 60) + (i % 5) / 10,
    t,
    kind: 0,
    pointerType: 0,
    trusted: 1,
  }));
}

function keysAt(
  times: number[],
  options: { trusted?: 0 | 1; hold?: number; category?: KeyCategory } = {},
): KeySample[] {
  const trusted = options.trusted ?? 1;
  const hold = options.hold ?? 90;
  const category = options.category ?? 0;
  const out: KeySample[] = [];
  let seq = 0;
  for (const t of times) {
    seq += 1;
    out.push({ seq, t, kind: 0, category, trusted });
    seq += 1;
    out.push({ seq, t: t + hold, kind: 1, category, trusted });
  }
  return out;
}

function clicksAt(times: number[], trusted: 0 | 1 = 1): ClickSample[] {
  const out: ClickSample[] = [];
  let seq = 0;
  for (const t of times) {
    seq += 1;
    out.push({ seq, x: 200, y: 100, t, kind: 0, button: 0, trusted });
    seq += 1;
    out.push({ seq, x: 200.5, y: 100.5, t: t + 80, kind: 1, button: 0, trusted });
  }
  return out;
}

function scrollsAt(times: number[]): ScrollSample[] {
  return times.map((t, i) => ({
    seq: i + 1,
    dx: 0,
    dy: -(20 + (i % 5)),
    t,
    trusted: 1,
    source: 0,
  }));
}

function inputsAt(times: number[], trusted: 0 | 1 = 1): InputSample[] {
  return times.map((t, i) => ({
    seq: i + 1,
    t,
    kind: 0,
    inputType: 0,
    trusted,
  }));
}

/** Sesión que parece humana: puntero con jitter, clics tras movimiento, texto tras tecla. */
function realisticSession(): {
  samples: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
} {
  const pointerTimes = timesFrom(HUMAN_DTS, 1000);
  const keyTimes = timesFrom(HUMAN_DTS, 5000);
  return {
    samples: humanPointers(),
    clicks: clicksAt([pointerTimes[4] + 1, pointerTimes[10] + 1, pointerTimes[16] + 1]),
    scrolls: scrollsAt(timesFrom(HUMAN_DTS, 9000)),
    keys: keysAt(keyTimes),
    inputs: inputsAt(keyTimes.map((t) => t + 45)),
  };
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

describe("L141/L145/L146: coherencia entre señales", () => {
  it("L141 mezcla sospechosa: puntero humano + teclado metrónomo -> alto", () => {
    const samples = humanPointers();
    const keys = keysAt(timesFrom(Array(20).fill(60), 5000));
    const mixed = evaluateCoherence(samples, [], [], keys, []).mixedSuspicious;
    expect(inUnit(mixed)).toBe(true);
    expect(mixed).toBeGreaterThan(0.8);

    // Sin mezcla: un solo flujo no puede comparar "personalidades".
    expect(evaluateCoherence(samples, [], [], [], []).mixedSuspicious).toBe(0);
  });

  it("L145 acciones sin evento previo: clics aislados -> alto; con puntero -> 0", () => {
    const clicks = clicksAt(timesFrom(Array(5).fill(150), 1000));
    const orphan = evaluateCoherence([], clicks, [], [], []).actionsWithoutPriorEvent;
    expect(inUnit(orphan)).toBe(true);
    expect(orphan).toBe(1);

    const session = realisticSession();
    expect(
      evaluateCoherence(
        session.samples,
        session.clicks,
        session.scrolls,
        session.keys,
        session.inputs,
      ).actionsWithoutPriorEvent,
    ).toBe(0);
  });

  it("L146 eventos fantasma: clics sin puntero -> alto; con movimiento previo -> 0", () => {
    const clicks = clicksAt(timesFrom(Array(5).fill(150), 1000));
    const phantom = evaluateCoherence([], clicks, [], [], []).phantomEvents;
    expect(inUnit(phantom)).toBe(true);
    expect(phantom).toBe(1);

    const session = realisticSession();
    expect(
      evaluateCoherence(
        session.samples,
        session.clicks,
        session.scrolls,
        session.keys,
        session.inputs,
      ).phantomEvents,
    ).toBe(0);
  });

  it("caso realista y vacío: las tres medidas en 0 y dentro de [0,1]", () => {
    const session = realisticSession();
    const signals = evaluateCoherence(
      session.samples,
      session.clicks,
      session.scrolls,
      session.keys,
      session.inputs,
    );
    expect(signals).toEqual({
      mixedSuspicious: 0,
      actionsWithoutPriorEvent: 0,
      phantomEvents: 0,
    });
    expect(evaluateCoherence([], [], [], [], [])).toEqual({
      mixedSuspicious: 0,
      actionsWithoutPriorEvent: 0,
      phantomEvents: 0,
    });
    for (const value of Object.values(signals)) expect(inUnit(value)).toBe(true);
  });
});

describe("L149/L150/L213/L215: entorno y anti-trampas", () => {
  it("L149 eventos creados por código: trusted === 0 -> alto, confiables -> 0", () => {
    const times = timesFrom(HUMAN_DTS, 1000);
    const risk = injectionRisk(
      keysAt(times, { trusted: 0 }),
      inputsAt(times, { trusted: 0 }),
      humanPointers().map((sample) => ({ ...sample, trusted: 0 as const })),
    );
    expect(inUnit(risk)).toBe(true);
    expect(risk).toBe(1);
    expect(injectionRisk([], [], [])).toBe(0);

    const session = realisticSession();
    expect(injectionRisk(session.keys, session.inputs, session.samples)).toBe(0);
  });

  it("L213 inyectados con trusted=1: dt idéntico y holds de 0ms -> alto", () => {
    const metronome = timesFrom(Array(20).fill(60), 5000);
    const risk = injectionRisk(keysAt(metronome, { hold: 0 }), [], humanPointers());
    expect(inUnit(risk)).toBe(true);
    expect(risk).toBeGreaterThan(0.8);

    // Sin holds de 0, el intervalo idéntico basta para dudar.
    expect(injectionRisk(keysAt(metronome), [], humanPointers())).toBeGreaterThan(0.5);
  });

  it("L150 dispositivo declarado vs comportamiento: contradicción -> alto", () => {
    const samples = humanPointers();
    expect(declaredVsBehavior("auto", samples, [], [])).toBe(0);
    expect(declaredVsBehavior("touch", [], [], [])).toBe(0);
    expect(declaredVsBehavior("desktop", samples, [], [])).toBe(0);
    expect(declaredVsBehavior("touch", samples, [], [])).toBe(1);
    expect(declaredVsBehavior("tv", [], [], inputsAt([1000, 1200]))).toBe(1);
    expect(declaredVsBehavior("desconocido", samples, [], [])).toBe(0);

    // Mando declarado y cadencia de mando: coherente.
    const remote = keysAt(timesFrom(HUMAN_DTS, 1000), { category: 5 });
    expect(declaredVsBehavior("tv", [], remote, [])).toBe(0);
    expect(inUnit(declaredVsBehavior("touch", samples, [], []))).toBe(true);
  });

  it("L215 humanización falsa: jitter periódico de ciclo corto -> alto", () => {
    const cycle = [100, 110, 120];
    const sawtooth: number[] = [];
    for (let i = 0; i < 21; i += 1) sawtooth.push(cycle[i % cycle.length]);
    const keys = keysAt(timesFrom(sawtooth.slice(1), 5000));
    const risk = humanizationRisk(keys, []);
    expect(inUnit(risk)).toBe(true);
    expect(risk).toBeGreaterThan(0.8);

    // Ruido uniforme de banda estrecha también puntúa.
    const uniform = Array.from({ length: 20 }, (_, i) => 100 + ((i * 7) % 19));
    expect(humanizationRisk(keysAt(timesFrom(uniform, 5000)), [])).toBeGreaterThan(0.5);
  });

  it("L215: tecleo humano y metrónomo no se confunden con humanización", () => {
    const session = realisticSession();
    expect(humanizationRisk(session.keys, session.inputs)).toBe(0);
    // Un metrónomo es inyección/rítmo exacto, NO "humanización" con jitter.
    expect(humanizationRisk(keysAt(timesFrom(Array(20).fill(60), 5000)), [])).toBe(0);
    expect(humanizationRisk([], [])).toBe(0);
  });
});

describe("L199/L204/L208: privacidad por construcción", () => {
  /** Ceros literales: el tipo exige `0`, no un número cualquiera. */
  function zeros(value: {
    networkCalls: 0;
    persistentStorage: 0;
    cookies: 0;
    keyIdentities: 0;
  }): boolean {
    return (
      value.networkCalls === 0 &&
      value.persistentStorage === 0 &&
      value.cookies === 0 &&
      value.keyIdentities === 0
    );
  }

  it("L199 cero envío de datos: auditoría literal y determinista", () => {
    const audit = privacyAudit();
    expect(zeros(audit)).toBe(true);
    expect(audit).toEqual({
      networkCalls: 0,
      persistentStorage: 0,
      cookies: 0,
      keyIdentities: 0,
    });
    expect(privacyAudit()).toEqual(audit);
  });

  it("L204 sin cookies/rastreo/huella: los módulos no contienen esas operaciones", async () => {
    const files = [
      "../src/core/coherence.ts",
      "../src/core/injection.ts",
      "../src/utils/privacy-audit.ts",
    ];
    const sources = await Promise.all(
      files.map(async (file) => {
        const raw = await Bun.file(new URL(file, import.meta.url)).text();
        // Se ignoran comentarios: mencionar una API al documentarla no es usarla.
        return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      }),
    );
    const code = sources.join("\n");
    expect(code).not.toMatch(/fetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/indexedDB/);
    expect(code).not.toMatch(/document\s*\.\s*cookie/);
    expect(code).not.toMatch(/navigator\s*\./);
    expect(zeros(privacyAudit())).toBe(true);
  });

  it("L208 aviso de transparencia: texto corto, español y veraz", () => {
    expect(typeof PRIVACY_NOTICE).toBe("string");
    expect(PRIVACY_NOTICE.length).toBeGreaterThan(40);
    expect(PRIVACY_NOTICE.length).toBeLessThan(250);
    expect(PRIVACY_NOTICE).toContain("no envía datos");
    expect(PRIVACY_NOTICE).toContain("cookies");
    expect(PRIVACY_NOTICE).toContain("teclas");
    expect(PRIVACY_NOTICE).toContain("texto");
    expect(PRIVACY_NOTICE).not.toMatch(/https?:\/\//);
  });
});
