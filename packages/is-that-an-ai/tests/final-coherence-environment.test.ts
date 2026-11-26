// Checklist final — coherencia (L137-L144) y entorno (L148, L151-L154).
// 100% determinista: sin reloj de pared, sin DOM real, sin red ni storage.
// Cubre los 11 campos nuevos con casos "agente" vs "humano", umbrales,
// caso límite, datos hostiles, SSR en proceso hijo y compatibilidad hacia atrás.

import { describe, expect, it } from "bun:test";
import {
  type CoherenceDetailed,
  type CoherenceSignals,
  evaluateCoherence,
  evaluateCoherenceDetailed,
  PRIOR_EVENT_LOOKBACK_MS,
} from "../src/core/coherence";
import {
  type EnvironmentHints,
  type EnvironmentSignals,
  evaluateEnvironment,
} from "../src/core/environment";
import { declaredVsBehavior, injectionRisk } from "../src/core/injection";
import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures deterministas
// ---------------------------------------------------------------------------

interface Fixture {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
}

function fixture(): Fixture {
  return { points: [], clicks: [], scrolls: [], keys: [], inputs: [] };
}

function point(t: number, kind: 0 | 1 | 2 = 0, pointerType: 0 | 1 | 2 | 3 = 0): PointerSample {
  return { seq: Math.round(t), x: 10, y: 20, t, kind, pointerType, trusted: 1 };
}
function click(t: number, kind: 0 | 1 = 0): ClickSample {
  return { seq: Math.round(t), x: 10, y: 20, t, kind, button: 0, trusted: 1 };
}
function scroll(t: number): ScrollSample {
  return { seq: Math.round(t), dx: 0, dy: 12, t, trusted: 1, source: 0 };
}
function key(t: number, kind: 0 | 1 = 0): KeySample {
  return { seq: Math.round(t), t, kind, category: 0, trusted: 1 };
}
function input(t: number): InputSample {
  return { seq: Math.round(t), t, kind: 0, inputType: 0, trusted: 1 };
}
function series(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function detailed(f: Fixture, now?: number): CoherenceDetailed {
  return evaluateCoherenceDetailed({ ...f, ...(now === undefined ? {} : { now }) });
}
function environment(f: Fixture, hints?: EnvironmentHints): EnvironmentSignals {
  return evaluateEnvironment({ ...f, ...(hints === undefined ? {} : { hints }) });
}

const ZERO_DETAILED: CoherenceDetailed = {
  mouseKeyboardOverlap: 0,
  clickBeforeTyping: 0,
  pointerBeforeAction: 0,
  temporalConsistency: 0,
  sessionVariety: 0,
  actionOrder: 0,
};
const ZERO_ENVIRONMENT: EnvironmentSignals = {
  automatedBrowser: 0,
  oddViewport: 0,
  noMovement: 0,
  noNormalEvents: 0,
  agentTools: 0,
};

function expectUnit(value: number, label: string): void {
  expect(typeof value, `${label}: tipo`).toBe("number");
  expect(Number.isFinite(value), `${label}: finito`).toBe(true);
  expect(value, `${label}: >= 0`).toBeGreaterThanOrEqual(0);
  expect(value, `${label}: <= 1`).toBeLessThanOrEqual(1);
}
function expectAllUnit(signals: CoherenceDetailed | EnvironmentSignals, label: string): void {
  for (const [field, value] of Object.entries(signals)) expectUnit(value, `${label}.${field}`);
}

// ---------------------------------------------------------------------------
// Compatibilidad hacia atrás (no se toca evaluateCoherence ni CoherenceSignals)
// ---------------------------------------------------------------------------

describe("compatibilidad hacia atrás", () => {
  it("evaluateCoherence mantiene su forma, su aridad y su resultado vacío", () => {
    const f = fixture();
    const signals: CoherenceSignals = evaluateCoherence(
      f.points,
      f.clicks,
      f.scrolls,
      f.keys,
      f.inputs,
    );
    expect(signals).toEqual({ mixedSuspicious: 0, actionsWithoutPriorEvent: 0, phantomEvents: 0 });
    expect(PRIOR_EVENT_LOOKBACK_MS).toBe(800);
    expect(evaluateCoherence.length).toBe(5);
    expect(evaluateCoherenceDetailed.length).toBe(1);
    expect(evaluateEnvironment.length).toBe(1);
  });

  it("un caso conocido sigue dando el mismo resultado que antes", () => {
    const f = fixture();
    f.clicks = [click(100)];
    const signals = evaluateCoherence(f.points, f.clicks, f.scrolls, f.keys, f.inputs);
    expect(signals.actionsWithoutPriorEvent).toBe(1);
    expect(signals.phantomEvents).toBe(1);
  });

  it("L149/L150 siguen disponibles y neutros con datos vacíos", () => {
    expect(typeof declaredVsBehavior).toBe("function");
    expect(injectionRisk([], [], [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coherencia detallada — vacío, pureza, horizonte y datos hostiles
// ---------------------------------------------------------------------------

describe("coherencia detallada: contrato base", () => {
  it("sin datos no acusa en ningún campo", () => {
    expect(detailed(fixture())).toEqual(ZERO_DETAILED);
  });

  it("no muta las entradas y es determinista", () => {
    const f = fixture();
    f.points = series(10, 100, 100).map((t) => point(t));
    f.clicks = series(10, 100, 100).map((t) => click(t));
    f.keys = series(10, 100, 100).map((t) => key(t));
    const before = JSON.stringify(f);
    const first = detailed(f);
    const second = detailed(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(first).toEqual(second);
    expectAllUnit(first, "detallada");
  });

  it("un horizonte `now` finito descarta muestras futuras (t > now)", () => {
    const f = fixture();
    f.points = series(10, 200, 100).map((t) => point(t));
    f.keys = series(10, 200, 100).map((t) => key(t));
    expect(detailed(f).mouseKeyboardOverlap).toBe(1);
    expect(detailed(f, 100)).toEqual(ZERO_DETAILED);
  });

  it("un horizonte `now` no finito se ignora (fail-closed)", () => {
    const f = fixture();
    f.points = series(10, 200, 100).map((t) => point(t));
    f.keys = series(10, 200, 100).map((t) => key(t));
    expect(detailed(f, Number.NaN).mouseKeyboardOverlap).toBe(1);
    expect(detailed(f, Number.POSITIVE_INFINITY).mouseKeyboardOverlap).toBe(1);
  });

  it("NaN/Infinity/negativos/huge no lanzan y nunca devuelven NaN", () => {
    const f = fixture();
    f.points = [
      point(NaN),
      point(Infinity),
      point(-Infinity),
      point(-500),
      point(1e308),
      point(-1e308),
      point(0),
    ];
    f.clicks = [click(NaN), click(-100), click(1e308), click(Infinity)];
    f.scrolls = [scroll(NaN), scroll(-1), scroll(1e308)];
    f.keys = [key(NaN), key(-100), key(1e308), key(Infinity), key(-Infinity)];
    f.inputs = [input(NaN), input(-1), input(1e308)];
    const result = detailed(f);
    expectAllUnit(result, "detallada hostil");
    expect(detailed(f, Number.NEGATIVE_INFINITY)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// L137 — mouseKeyboardOverlap
// ---------------------------------------------------------------------------

describe("L137 mouseKeyboardOverlap", () => {
  it("agente: puntero y escritura sincronizados al milisegundo -> 1", () => {
    const f = fixture();
    f.keys = series(10, 100, 100).map((t) => key(t));
    f.points = series(10, 100, 100).map((t) => point(t));
    expect(detailed(f).mouseKeyboardOverlap).toBe(1);
  });

  it("humano: el puntero está lejos de la escritura -> 0", () => {
    const f = fixture();
    f.keys = series(10, 100, 100).map((t) => key(t));
    f.points = series(10, 5000, 40).map((t) => point(t));
    expect(detailed(f).mouseKeyboardOverlap).toBe(0);
  });

  it("sincronización parcial (3 de 10) -> valor interpolado, no constante", () => {
    const f = fixture();
    f.keys = series(10, 100, 100).map((t) => key(t));
    f.points = series(3, 100, 100).map((t) => point(t));
    expect(detailed(f).mouseKeyboardOverlap).toBeCloseTo((0.3 - 0.2) / 0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// L138 — clickBeforeTyping
// ---------------------------------------------------------------------------

describe("L138 clickBeforeTyping", () => {
  it("agente: escribe sin ningún clic que enfocara el campo -> 1", () => {
    const f = fixture();
    f.keys = series(10, 1000, 100).map((t) => key(t));
    expect(detailed(f).clickBeforeTyping).toBe(1);
  });

  it("humano: hay un clic antes de cada ráfaga de escritura -> 0", () => {
    const f = fixture();
    f.clicks = [click(900), click(4900)];
    f.keys = [...series(5, 1000, 100), ...series(5, 5000, 100)].map((t) => key(t));
    expect(detailed(f).clickBeforeTyping).toBe(0);
  });

  it("dos ráfagas, solo una explicada por un clic -> 0.5", () => {
    const f = fixture();
    f.clicks = [click(50)];
    f.keys = [...series(3, 100, 100), ...series(3, 5000, 100)].map((t) => key(t));
    expect(detailed(f).clickBeforeTyping).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// L139 — pointerBeforeAction (proxy numérico de "mirar antes de actuar")
// ---------------------------------------------------------------------------

describe("L139 pointerBeforeAction", () => {
  it("agente: clics sin ningún movimiento de puntero previo -> 1", () => {
    const f = fixture();
    f.clicks = series(10, 1000, 100).map((t) => click(t));
    expect(detailed(f).pointerBeforeAction).toBe(1);
  });

  it("humano: movimiento antes de cada clic -> 0", () => {
    const f = fixture();
    f.clicks = series(10, 1000, 100).map((t) => click(t));
    f.points = series(10, 980, 100).map((t) => point(t));
    expect(detailed(f).pointerBeforeAction).toBe(0);
  });

  it("mitad de los clics con movimiento previo -> 0.8", () => {
    const f = fixture();
    // Segundo grupo a 5000ms: fuera de la ventana de 400ms del último movimiento.
    f.clicks = [...series(5, 1000, 100), ...series(5, 5000, 100)].map((t) => click(t));
    f.points = series(5, 980, 100).map((t) => point(t));
    expect(detailed(f).pointerBeforeAction).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// L142 — temporalConsistency
// ---------------------------------------------------------------------------

describe("L142 temporalConsistency", () => {
  it("agente: primera mitad robótica y segunda irregular -> 1", () => {
    const f = fixture();
    f.keys = [...series(5, 100, 50), 1000, 1137, 1426, 2048, 2948].map((t) => key(t));
    expect(detailed(f).temporalConsistency).toBe(1);
  });

  it("humano: ritmo irregular en ambas mitades -> 0", () => {
    const f = fixture();
    f.keys = [0, 137, 289, 622, 900, 1100, 1237, 1489, 1822, 2100].map((t) => key(t));
    expect(detailed(f).temporalConsistency).toBe(0);
  });

  it("muestra insuficiente por mitad (<4) no acusa", () => {
    const f = fixture();
    f.keys = series(6, 100, 50).map((t) => key(t));
    expect(detailed(f).temporalConsistency).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L143 — sessionVariety
// ---------------------------------------------------------------------------

describe("L143 sessionVariety", () => {
  it("agente: intervalos idénticos (se repite) -> 1", () => {
    const f = fixture();
    f.keys = series(10, 100, 50).map((t) => key(t));
    expect(detailed(f).sessionVariety).toBe(1);
  });

  it("humanos: todos los intervalos distintos -> 0", () => {
    const f = fixture();
    const deltas = [137, 152, 333, 278, 191, 421, 264, 309, 187];
    let t = 100;
    const times = [t];
    for (const delta of deltas) {
      t += delta;
      times.push(t);
    }
    f.keys = times.map((m) => key(m));
    expect(detailed(f).sessionVariety).toBe(0);
  });

  it("menos de 3 intervalos no acusa", () => {
    const f = fixture();
    f.keys = series(3, 100, 50).map((t) => key(t));
    expect(detailed(f).sessionVariety).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L144 — actionOrder
// ---------------------------------------------------------------------------

describe("L144 actionOrder", () => {
  it("agente: solo eventos up (sin down) -> 1", () => {
    const f = fixture();
    f.keys = series(10, 100, 50).map((t) => key(t, 1));
    expect(detailed(f).actionOrder).toBe(1);
  });

  it("humano: down antes de up -> 0", () => {
    const f = fixture();
    for (let i = 0; i < 10; i += 1) {
      f.keys.push(key(i * 100, 0), key(i * 100 + 20, 1));
    }
    expect(detailed(f).actionOrder).toBe(0);
  });

  it("mitad de los ups invertidos -> 0.8", () => {
    const f = fixture();
    // Cinco ups huérfanos ANTES de cualquier down (no hay down que los explique).
    f.keys = [10, 20, 30, 40, 50].map((t) => key(t, 1));
    for (let i = 0; i < 5; i += 1) {
      f.keys.push(key(100 + i * 100, 0), key(110 + i * 100, 1));
    }
    expect(detailed(f).actionOrder).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// Entorno — vacío, pistas hostiles y las cinco señales
// ---------------------------------------------------------------------------

describe("entorno: contrato base", () => {
  it("sin datos ni pistas no acusa", () => {
    expect(environment(fixture())).toEqual(ZERO_ENVIRONMENT);
  });

  it("pistas hostiles no lanzan y permanecen en [0,1]", () => {
    const hints = {
      webdriver: "yes" as unknown as boolean,
      maxTouchPoints: Number.NaN,
      screenWidth: Number.NEGATIVE_INFINITY,
      screenHeight: Number.POSITIVE_INFINITY,
      mobile: 1 as unknown as boolean,
      userAgent: null as unknown as string,
    };
    const signals = environment(fixture(), hints);
    expectAllUnit(signals, "entorno hostil");
    expect(signals).toEqual(ZERO_ENVIRONMENT);
  });

  it("datos de muestra hostiles no contaminan las señales de entorno", () => {
    const f = fixture();
    f.points = [point(NaN), point(Infinity), point(-1), point(1e308)];
    f.clicks = [click(NaN), click(-100)];
    f.keys = [key(Infinity), key(-50)];
    expectAllUnit(environment(f), "entorno hostil muestras");
  });
});

describe("L148 automatedBrowser", () => {
  it("flag webdriver=true -> 1", () => {
    expect(environment(fixture(), { webdriver: true }).automatedBrowser).toBe(1);
  });
  it("UA headless con tres marcadores -> 1", () => {
    expect(
      environment(fixture(), { userAgent: "HeadlessChrome/120.0 WebDriver" }).automatedBrowser,
    ).toBe(1);
  });
  it("un solo marcador de automatización -> 0.75", () => {
    expect(
      environment(fixture(), { userAgent: "MyAutomationTool/1.0" }).automatedBrowser,
    ).toBeCloseTo(0.75, 5);
  });
  it("móvil que declara cero puntos táctiles -> 0.8", () => {
    expect(
      environment(fixture(), { mobile: true, maxTouchPoints: 0 }).automatedBrowser,
    ).toBeCloseTo(0.8, 5);
  });
  it("navegador humano -> 0", () => {
    const hints: EnvironmentHints = {
      webdriver: false,
      maxTouchPoints: 1,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    expect(environment(fixture(), hints).automatedBrowser).toBe(0);
  });
});

describe("L151 oddViewport", () => {
  it("viewport por defecto de headless (800x600) -> 1", () => {
    expect(environment(fixture(), { screenWidth: 800, screenHeight: 600 }).oddViewport).toBe(1);
  });
  it("tamaño degenerado -> 1", () => {
    expect(environment(fixture(), { screenWidth: 0, screenHeight: 0 }).oddViewport).toBe(1);
  });
  it("cerca de un default de headless (±2px) -> 0.6", () => {
    expect(environment(fixture(), { screenWidth: 802, screenHeight: 602 }).oddViewport).toBeCloseTo(
      0.6,
      5,
    );
    // Fraccional cerca del default: 0.6, no el 1 del match exacto.
    expect(
      environment(fixture(), { screenWidth: 800.4, screenHeight: 600.4 }).oddViewport,
    ).toBeCloseTo(0.6, 5);
  });
  it("proporción extrema en escritorio -> 0.7", () => {
    expect(
      environment(fixture(), { screenWidth: 3000, screenHeight: 400, mobile: false }).oddViewport,
    ).toBeCloseTo(0.7, 5);
  });
  it("viewport humano corriente -> 0", () => {
    expect(environment(fixture(), { screenWidth: 1920, screenHeight: 1080 }).oddViewport).toBe(0);
  });
  it("tamaño no finito -> sin evidencia (0)", () => {
    expect(
      environment(fixture(), { screenWidth: Number.NaN, screenHeight: Infinity }).oddViewport,
    ).toBe(0);
  });
});

describe("L152 noMovement", () => {
  it("sesión larga sin movimiento -> 1", () => {
    const f = fixture();
    f.keys = series(40, 100, 100).map((t) => key(t));
    expect(environment(f).noMovement).toBe(1);
  });
  it("escala con el número de eventos (20 -> 0.375)", () => {
    const f = fixture();
    f.keys = series(20, 100, 100).map((t) => key(t));
    expect(environment(f).noMovement).toBeCloseTo(12 / 32, 5);
  });
  it("humano: un movimiento de puntero basta -> 0", () => {
    const f = fixture();
    f.keys = series(40, 100, 100).map((t) => key(t));
    f.points = [point(150)];
    expect(environment(f).noMovement).toBe(0);
  });
  it("sesión corta -> 0", () => {
    const f = fixture();
    f.keys = series(6, 100, 20).map((t) => key(t));
    expect(environment(f).noMovement).toBe(0);
  });
});

describe("L153 noNormalEvents", () => {
  it("un solo flujo con muchos eventos -> 1", () => {
    const f = fixture();
    f.inputs = series(20, 100, 50).map((t) => input(t));
    expect(environment(f).noNormalEvents).toBe(1);
  });
  it("dos flujos -> ~0.67", () => {
    const f = fixture();
    f.inputs = series(20, 100, 50).map((t) => input(t));
    f.keys = series(20, 100, 50).map((t) => key(t));
    expect(environment(f).noNormalEvents).toBeCloseTo(2 / 3, 5);
  });
  it("humano: los cinco flujos generan eventos -> 0", () => {
    const f = fixture();
    f.points = [point(100)];
    f.clicks = [click(200)];
    f.scrolls = [scroll(300)];
    f.keys = [key(400)];
    f.inputs = [input(500)];
    expect(environment(f).noNormalEvents).toBe(0);
  });
  it("pocos eventos no acusa", () => {
    const f = fixture();
    f.keys = [key(100), key(200)];
    expect(environment(f).noNormalEvents).toBe(0);
  });
});

describe("L154 agentTools", () => {
  it("una herramienta conocida -> 0.75", () => {
    expect(environment(fixture(), { userAgent: "Puppeteer/20.0" }).agentTools).toBeCloseTo(0.75, 5);
  });
  it("dos herramientas -> 1", () => {
    expect(environment(fixture(), { userAgent: "python-requests/2.31 curl/8.5" }).agentTools).toBe(
      1,
    );
  });
  it("UA humano -> 0", () => {
    expect(
      environment(fixture(), { userAgent: "Mozilla/5.0 Chrome/120.0 Safari/537.36" }).agentTools,
    ).toBe(0);
  });
});

describe("perfil de agente completo", () => {
  it("varias señales de entorno se disparan a la vez sin tocar el score", () => {
    const f = fixture();
    f.keys = series(40, 100, 100).map((t) => key(t));
    const signals = environment(f, {
      webdriver: true,
      screenWidth: 800,
      screenHeight: 600,
      userAgent: "HeadlessChrome WebDriver Puppeteer Selenium",
    });
    expect(signals).toEqual({
      automatedBrowser: 1,
      oddViewport: 1,
      noMovement: 1,
      noNormalEvents: 1,
      agentTools: 1,
    });
    // Las medidas son aditivas: evaluarlas no altera el scoring existente.
    expect(evaluateCoherence(f.points, f.clicks, f.scrolls, f.keys, f.inputs)).toEqual({
      mixedSuspicious: 0,
      actionsWithoutPriorEvent: 0,
      phantomEvents: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// SSR: importar y ejecutar ambos módulos sin globals de DOM, en proceso aparte
// ---------------------------------------------------------------------------

describe("SSR: importación sin window/document/navigator", () => {
  it("los módulos cargan y devuelven 0 con datos vacíos", () => {
    const coherenceEntry = new URL("../src/core/coherence.ts", import.meta.url).href;
    const environmentEntry = new URL("../src/core/environment.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `const coherence = await import(${JSON.stringify(coherenceEntry)});`,
      `const environment = await import(${JSON.stringify(environmentEntry)});`,
      'if (typeof coherence.evaluateCoherence !== "function" || typeof coherence.evaluateCoherenceDetailed !== "function") process.exit(2);',
      'if (typeof environment.evaluateEnvironment !== "function") process.exit(3);',
      "const empty = { points: [], clicks: [], scrolls: [], keys: [], inputs: [] };",
      "const c = coherence.evaluateCoherenceDetailed(empty);",
      "const e = environment.evaluateEnvironment(empty);",
      "if (Object.values(c).some((v) => v !== 0) || Object.values(e).some((v) => v !== 0)) process.exit(4);",
      "process.stdout.write(JSON.stringify({ c, e }));",
    ].join("\n");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout);
    expect(JSON.parse(output)).toEqual({ c: ZERO_DETAILED, e: ZERO_ENVIRONMENT });
  });
});
