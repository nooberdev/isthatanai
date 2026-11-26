// Auditoría realista de TODOS los ítems de CLICKS (L54-L68) y SCROLL (L104-L112)
// del checklist. Cada prueba usa muestras numéricas plausibles (sin DOM, red,
// almacenamiento ni identidad de texto) y comprueba que la medida es finita,
// está en [0,1] y apunta en la dirección semántica documentada:
//   1 = más probable IA (bot), 0 = más probable humano.
//
// Los escenarios "bot" incluyen: cuadrícula fija de 100 ms, clics instantáneos,
// arrastre con deriva constante, ráfagas, doble clic mecánico, barrido monótono,
// scroll en saltos exactos, rueda sin desaceleración y salto instantáneo al final.
// Los escenarios "humano" incluyen: doble clic con tiempos variables, arrastre y
// selección de texto con deriva natural, botones secundarios, saltos por la página,
// rueda con ruido, pausas de lectura, cambios de dirección e inercia de trackpad.
//
// Umbrales de cada medida están documentados en los archivos `features/click.ts`
// y `features/scroll.ts`; aquí solo se verifica su comportamiento con datos reales.

import { describe, expect, it } from "bun:test";
import type { ClickSample, ScrollSample } from "../../src/index";
import {
  CLICK_NEUTRAL,
  CLICK_OPT_IN_FEATURE_WEIGHTS,
  clickBurstiness,
  clickConsecutiveSpeed,
  clickDoubleClickRhythm,
  clickDownUpDrift,
  clickDurationRegularity,
  clickFirstClickLatency,
  clickInstantaneous,
  clickIntervalRegularity,
  clickNaturalDrag,
  clickNonInteractive,
  clickNoPriorMovement,
  clickOrder,
  clickSecondaryButtons,
  clickTextSelection,
  extractClickFeatures,
  extractFinalClickFeatures,
  extractFinalScrollFeatures,
  extractOptInClickFeatures,
  extractPartialClickFeatures,
  extractPartialScrollFeatures,
  extractScrollFeatures,
  SCROLL_NEUTRAL,
  scrollDecelerationProfile,
  scrollDeltaUniformity,
  scrollDirectionChanges,
  scrollInstantEnd,
  scrollIntervalRegularity,
  scrollLargeJumps,
  scrollNoOtherMovement,
  scrollNoPauses,
  scrollProportional,
  scrollRoundDeltas,
  scrollSpeed,
} from "../../src/index";

// ---------------------------------------------------------------------------
// Generadores de escenarios realistas (solo números).
// ---------------------------------------------------------------------------

interface ClickSpec {
  x: number;
  y: number;
  down: number;
  up: number;
  upX?: number;
  upY?: number;
  button?: number;
  trusted?: 0 | 1;
}

function clickSamples(specs: ClickSpec[]): ClickSample[] {
  const out: ClickSample[] = [];
  let seq = 0;
  for (const s of specs) {
    const button = s.button ?? 0;
    const trusted = s.trusted ?? 1;
    out.push({ seq: ++seq, x: s.x, y: s.y, t: s.down, kind: 0, button, trusted });
    out.push({
      seq: ++seq,
      x: s.upX ?? s.x,
      y: s.upY ?? s.y,
      t: s.up,
      kind: 1,
      button,
      trusted,
    });
  }
  return out;
}

interface ScrollOpts {
  dx?: number[];
  source?: 0 | 1;
  trusted?: 0 | 1;
}

function scrollSamples(dy: number[], t: number[], opts: ScrollOpts = {}): ScrollSample[] {
  return dy.map((d, i) => ({
    seq: i + 1,
    dx: opts.dx?.[i] ?? 0,
    dy: d,
    t: t[i],
    trusted: opts.trusted ?? 1,
    source: opts.source ?? 0,
  }));
}

function unit(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

function allUnit(features: Record<string, number>): void {
  for (const value of Object.values(features)) unit(value);
}

/** Humano: clics de propósitos distintos, duraciones/gaps muy variables. */
const HUMAN_DURATIONS = [30, 220, 55, 260, 40, 190, 70, 240];
const HUMAN_GAPS = [200, 150, 1600, 180, 1700, 220, 1500];
const HUMAN_DRIFT = [12, 15, 9, 18, 20, 11, 16, 14];

function humanVariedClicks(): ClickSample[] {
  let t = 900; // primer clic ~900 ms tras la carga de la página
  const specs: ClickSpec[] = [];
  for (let i = 0; i < 8; i += 1) {
    const x = 120 + i * 93 + (i % 3) * 0.4;
    const y = 60 + (i % 4) * 77 + 0.3;
    specs.push({
      x,
      y,
      down: t,
      up: t + HUMAN_DURATIONS[i],
      upX: x + HUMAN_DRIFT[i],
      upY: y + (i % 2 === 0 ? 3 : -4),
    });
    t += HUMAN_GAPS[i] ?? 200;
  }
  return clickSamples(specs);
}

/** Bot: misma posición, duración fija de 60 ms y cuadrícula exacta de 100 ms. */
function botGridClicks(): ClickSample[] {
  return clickSamples(
    Array.from({ length: 8 }, (_, i) => ({
      x: 500.5,
      y: 300.25,
      down: 500 + i * 100,
      up: 500 + i * 100 + 60,
    })),
  );
}

/** Humano: doble clic real, con intervalos de 130/165/190 ms (no metrónomo). */
function humanDoubleClicks(): ClickSample[] {
  const starts = [1000, 1130, 2400, 2565, 3900, 4090, 5200, 5390];
  const durations = [42, 55, 38, 61, 47, 52, 44, 58];
  const xs = [200, 201.4, 199.2, 202.1, 350, 351.6, 348.9, 352.2];
  const ys = [120, 121.2, 119.6, 122, 300, 301.1, 299.4, 302];
  return clickSamples(
    starts.map((down, i) => ({
      x: xs[i],
      y: ys[i],
      down,
      up: down + durations[i],
      upX: xs[i] + 0.8,
      upY: ys[i] - 0.5,
    })),
  );
}

/** Bot: doble clic con intervalo exacto de 120 ms y duración fija de 50 ms. */
function botDoubleClicks(): ClickSample[] {
  return clickSamples(
    Array.from({ length: 8 }, (_, i) => ({
      x: 500,
      y: 300,
      down: 600 + i * 120,
      up: 600 + i * 120 + 50,
    })),
  );
}

/** Bot: eventos sintéticos, down y up en el mismo instante (0 ms). */
function botInstantClicks(): ClickSample[] {
  return clickSamples(
    Array.from({ length: 6 }, (_, i) => ({
      x: 700,
      y: 400,
      down: 1000 + i * 100,
      up: 1000 + i * 100,
    })),
  );
}

/** Humano: arrastrar y soltar con deriva natural (8-30 px) y pausas entre gestos. */
function humanDragClicks(): ClickSample[] {
  const drifts = [8, 22, 15, 30, 11, 19];
  const durations = [120, 90, 150, 110, 180, 95];
  const starts = [500, 1400, 2300, 3200, 4300, 5200];
  const xs = [100, 250, 410, 560, 700, 830];
  const ys = [200, 140, 260, 180, 300, 220];
  return clickSamples(
    xs.map((x, i) => ({
      x,
      y: ys[i],
      down: starts[i],
      up: starts[i] + durations[i],
      upX: x + drifts[i],
      upY: ys[i] + (i % 2 === 0 ? 3 : -4),
    })),
  );
}

/** Bot: arrastre siempre idéntico (25 px) y mismo intervalo. */
function botDragClicks(): ClickSample[] {
  return clickSamples(
    Array.from({ length: 6 }, (_, i) => ({
      x: 100 + i * 120,
      y: 200,
      down: 500 + i * 600,
      up: 500 + i * 600 + 100,
      upX: 100 + i * 120 + 25,
      upY: 200,
    })),
  );
}

/** Humano: seleccionar texto arrastrando 45-60 px durante 180-310 ms. */
function humanSelectionClicks(): ClickSample[] {
  return clickSamples([
    { x: 120, y: 300, down: 800, up: 1050, upX: 175, upY: 304 },
    { x: 260, y: 300, down: 2200, up: 2510, upX: 320, upY: 297 },
    { x: 410, y: 300, down: 3700, up: 3880, upX: 455, upY: 303 },
  ]);
}

/** Humano: mezcla clic izquierdo, derecho (botón 2) y medio (botón 1). */
function mixedButtonClicks(): ClickSample[] {
  return clickSamples([
    { x: 100, y: 100, down: 800, up: 860, button: 0 },
    { x: 220, y: 160, down: 1500, up: 1580, button: 2 },
    { x: 330, y: 120, down: 2300, up: 2360, button: 0 },
    { x: 440, y: 200, down: 3200, up: 3300, button: 1 },
    { x: 550, y: 180, down: 4100, up: 4170, button: 0 },
    { x: 180, y: 260, down: 5000, up: 5075, button: 0 },
    { x: 390, y: 300, down: 5900, up: 5980, button: 0 },
    { x: 620, y: 220, down: 6800, up: 6870, button: 0 },
  ]);
}

/** Humano: salta entre zonas de la página en vez de barrerla en orden. */
function humanJumpingClicks(): ClickSample[] {
  const points = [
    [100, 100],
    [320, 240],
    [180, 300],
    [420, 120],
    [240, 340],
    [380, 200],
    [140, 260],
    [450, 80],
  ];
  return clickSamples(
    points.map(([x, y], i) => ({
      x,
      y,
      down: 900 + i * 520,
      up: 900 + i * 520 + 60,
      upX: x + 6,
      upY: y + 3,
    })),
  );
}

/** Bot: barrido monótono en X (como una lista de tareas). */
function botSweepClicks(): ClickSample[] {
  return clickSamples(
    Array.from({ length: 8 }, (_, i) => ({
      x: 100 + i * 60,
      y: 100,
      down: 600 + i * 300,
      up: 600 + i * 300 + 60,
    })),
  );
}

/** Humano: rueda con ruido, reversiones de dirección y pausas de lectura. */
function humanReadingScroll(): ScrollSample[] {
  const intervals = [20, 90, 35, 240, 60, 270, 45, 220, 80, 250, 70];
  const dy = [123.7, -94.2, 71.3, -46.8, 27.5, 13.4, -88.6, 32.1, -63.7, 29.4, -44.8, 17.2];
  const dx = dy.map((d, i) => (i % 2 === 0 ? 0.3 * d : -0.3 * d));
  const t = [0];
  for (const dt of intervals) t.push(t[t.length - 1] + dt);
  return scrollSamples(dy, t, { dx });
}

/** Bot: 100 px exactos cada 100 ms, sin ruido, sin pausas, una dirección. */
function botExactScroll(): ScrollSample[] {
  return scrollSamples(
    Array(12).fill(100),
    Array.from({ length: 12 }, (_, i) => i * 100),
  );
}

/** Bot: desplazamiento rápido (200 px cada 16 ms = 12.5 px/ms). */
function botFastScroll(): ScrollSample[] {
  return scrollSamples(
    Array(8).fill(200),
    Array.from({ length: 8 }, (_, i) => i * 16),
  );
}

/** Humano: trackpad con inercia natural (magnitudes decrecientes), rituo con jitter. */
function humanTrackpadScroll(): ScrollSample[] {
  const dy = [180, 150, 122, 98, 76, 58, 42, 30, 20, 12];
  const t = [0, 16, 35, 56, 73, 89, 112, 130, 147];
  return scrollSamples(dy, t);
}

/** Bot: rueda sin desaceleración (magnitud constante) con jitter de_intervalo. */
function botNoDecelerationScroll(): ScrollSample[] {
  const t = [0, 16, 35, 56, 73, 89, 112, 130, 147];
  return scrollSamples(Array(9).fill(100), t);
}

/** Bot: saltos exactos de 400 px separados por pausas (>300 ms => trazos distintos). */
function botJumpScroll(): ScrollSample[] {
  return scrollSamples([400, 400, 400, 400, 400], [0, 900, 1800, 2700, 3600]);
}

/** Humano: sube y baja alternando trazos cortos con pausas de lectura. */
function humanUpDownScroll(): ScrollSample[] {
  const t = [0, 42, 71, 1380, 1425, 1493, 2960, 3008, 3067];
  const dy = [118, -92, 137, -76, 129, -104, 141, -88, 133];
  return scrollSamples(dy, t, { dx: dy.map((d, i) => (i % 2 ? 0.2 * d : -0.2 * d)) });
}

/** Humano: la rueda crece con el tiempo dedicado (dy correlacionado con el gap). */
function humanProportionalScroll(): ScrollSample[] {
  return scrollSamples([10, 20, 40, 80, 160], [0, 10, 30, 70, 150]);
}

/** Humano: intervalos con jitter real (no un metrónomo). */
function humanJitterScroll(): ScrollSample[] {
  return scrollSamples([10, 10, 10, 10, 10], [0, 20, 90, 130, 260]);
}

/** Bot: autoscroll del botón medio (source=1, |dy|<=100, cadencia de frame). */
function humanAutoscroll(): ScrollSample[] {
  return scrollSamples(
    Array(12).fill(40),
    Array.from({ length: 12 }, (_, i) => i * 16),
    {
      source: 1,
    },
  );
}

/** Bot: salto instantáneo al final (2 eventos, >=1000 px). */
function botInstantEndScroll(): ScrollSample[] {
  return scrollSamples([1500, 0], [0, 5]);
}

// ---------------------------------------------------------------------------
// CLICKS — L54 .. L68
// ---------------------------------------------------------------------------

describe("checklist CLICKS · escenarios realistas", () => {
  it("L54 Duración del click: humana variable -> bajo; bot 60 ms fijo -> alto", () => {
    const human = clickDurationRegularity(humanVariedClicks());
    const bot = clickDurationRegularity(botGridClicks());
    unit(human);
    unit(bot);
    // Umbral: CV <=0.08 -> 1, >=0.5 -> 0. La persona varía 30-260 ms; el bot no.
    expect(human).toBeLessThan(0.3);
    expect(bot).toBeGreaterThan(0.9);
  });

  it("L55 Click instantáneo (0 ms): humano -> 0; sintético 0 ms -> 1", () => {
    const human = clickInstantaneous(humanVariedClicks());
    const bot = clickInstantaneous(botInstantClicks());
    unit(human);
    unit(bot);
    // Umbral: ratio de pares <=1 ms, 0 -> 0, >=0.5 -> 1.
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L56 Movimiento durante el click: arrastre humano -> bajo; bot sin deriva -> alto", () => {
    const human = clickDownUpDrift(humanDragClicks());
    // 1 = IA = el bot suelta exactamente donde presionó (deriva 0).
    const bot = clickDownUpDrift(botGridClicks());
    unit(human);
    unit(bot);
    // Umbral: deriva media <=1 px -> 1, >=12 px -> 0.
    expect(human).toBeLessThan(0.2);
    expect(bot).toBeGreaterThan(0.9);
  });

  it("L57 Posición al presionar vs. soltar: humano con desplazamiento 2D -> bajo", () => {
    // Distancia euclídea real (x e y distintas), no solo desplazamiento en X.
    const human = clickDownUpDrift(humanDragClicks());
    const bot = clickDownUpDrift(
      clickSamples([
        { x: 50, y: 50, down: 0, up: 80 },
        { x: 150, y: 50, down: 400, up: 480 },
        { x: 250, y: 50, down: 800, up: 880 },
      ]),
    );
    unit(human);
    unit(bot);
    expect(human).toBeLessThan(0.2);
    expect(bot).toBe(1);
  });

  it("L58 Ritmo del doble click: humano 130/165/190 ms -> bajo; bot 120 ms fijo -> alto", () => {
    const human = clickDoubleClickRhythm(humanDoubleClicks());
    const bot = clickDoubleClickRhythm(botDoubleClicks());
    unit(human);
    unit(bot);
    // Umbral: CV <=0.01 -> 1, >=0.1 -> 0, solo intervalos de 60-400 ms.
    expect(human).toBeLessThan(0.3);
    expect(bot).toBeGreaterThan(0.9);
  });

  it("L59 Clicks repetidos, intervalos parejos: bot 100 ms -> alto; humano -> bajo", () => {
    const bot = clickIntervalRegularity(botGridClicks());
    const human = clickIntervalRegularity(humanVariedClicks());
    unit(bot);
    unit(human);
    // Umbral: CV <=0.08 -> 1, >=0.5 -> 0.
    expect(bot).toBe(1);
    expect(human).toBeLessThan(0.2);
  });

  it("L60 Click sin movimiento previo: bot siempre el mismo punto -> alto", () => {
    const bot = clickNoPriorMovement(botGridClicks());
    const human = clickNoPriorMovement(
      clickSamples(
        [
          [100, 120],
          [340, 250],
          [180, 400],
          [520, 90],
          [260, 320],
        ].map(([x, y], i) => ({ x, y, down: 700 + i * 600, up: 700 + i * 600 + 70 })),
      ),
    );
    unit(bot);
    unit(human);
    // Umbral: share de down consecutivos a <=1 px, 0.2 -> 0, 0.8 -> 1.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L61 Tiempo hasta el primer click: bot a 5 ms -> alto; humano a 1200 ms -> bajo", () => {
    const bot = clickFirstClickLatency(
      clickSamples([
        { x: 100, y: 100, down: 5, up: 20 },
        { x: 100, y: 100, down: 120, up: 180 },
        { x: 100, y: 100, down: 220, up: 280 },
      ]),
    );
    const human = clickFirstClickLatency(
      clickSamples([
        { x: 100, y: 100, down: 1200, up: 1270 },
        { x: 100, y: 100, down: 1700, up: 1770 },
      ]),
    );
    unit(bot);
    unit(human);
    // Umbral documentado: t <=50 ms -> 1, t >=500 ms -> 0.
    expect(bot).toBe(1);
    expect(human).toBe(0);
    expect(clickFirstClickLatency([])).toBe(CLICK_NEUTRAL);
  });

  it("L62 Click derecho/medio y arrastres: humano con secundarios -> bajo; bot solo primario -> alto", () => {
    const human = clickSecondaryButtons(mixedButtonClicks());
    const bot = clickSecondaryButtons(botGridClicks());
    unit(human);
    unit(bot);
    // Umbral: ratio de muestras button!==0, 0 -> 1, >=0.05 -> 0.
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L63 Arrastrar y soltar, trayectoria natural: humano variable -> bajo; bot fijo -> alto", () => {
    const human = clickNaturalDrag(humanDragClicks());
    const bot = clickNaturalDrag(botDragClicks());
    unit(human);
    unit(bot);
    // Umbral: CV de las derivas >1 px, <=0.05 -> 1, >=0.4 -> 0.
    expect(human).toBeLessThan(0.2);
    expect(bot).toBe(1);
  });

  it("L64 Selección de texto arrastrando: humano 45-60 px/180-310 ms -> bajo; bot -> alto", () => {
    const human = clickTextSelection(humanSelectionClicks());
    const bot = clickTextSelection(botGridClicks());
    unit(human);
    unit(bot);
    // Umbral: share de pares (deriva>=20 px y duración>=100 ms); 0 -> 1, >=0.3 -> 0.
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L65 Click en zonas no clickeables: bot repite punto -> alto; humano explora -> bajo", () => {
    const bot = clickNonInteractive(botGridClicks());
    const human = clickNonInteractive(humanJumpingClicks());
    unit(bot);
    unit(human);
    // Umbral: share de posiciones únicas (radio 5 px), <=0.4 -> 1, >=0.9 -> 0.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L66 Orden de los clicks: bot en barrido monótono -> alto; humano salta -> bajo", () => {
    const bot = clickOrder(botSweepClicks());
    const human = clickOrder(humanJumpingClicks());
    unit(bot);
    unit(human);
    // Umbral: consistencia de signo en X/Y, <=0.5 -> 0, >=0.95 -> 1.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L67 Velocidad de clicks seguidos: bot 10/s -> alto; humano ~2/s -> bajo", () => {
    const bot = clickConsecutiveSpeed(botGridClicks());
    const human = clickConsecutiveSpeed(humanVariedClicks());
    unit(bot);
    unit(human);
    // Umbral: clics/s (mediana de intervalos) <=5 -> 0, >=10 -> 1.
    expect(bot).toBe(1);
    expect(human).toBe(0);
    expect(clickConsecutiveSpeed([])).toBe(CLICK_NEUTRAL);
  });

  it("L68 Ráfagas de clicks: bot a 100 ms -> alto; humano espaciado -> bajo", () => {
    const bot = clickBurstiness(botGridClicks());
    const human = clickBurstiness(humanVariedClicks());
    unit(bot);
    unit(human);
    // Umbral: ratio de intervalos <=150 ms, 0.7 -> 0, 0.95 -> 1.
    expect(bot).toBe(1);
    expect(human).toBeLessThan(0.1);
  });

  it("L55-L68 · extractores: todas las medidas finitas y tabla opt-in a peso 0", () => {
    for (const samples of [
      humanVariedClicks(),
      botGridClicks(),
      humanDoubleClicks(),
      humanSelectionClicks(),
      mixedButtonClicks(),
    ]) {
      allUnit(extractClickFeatures(samples));
      allUnit(extractPartialClickFeatures(samples));
      allUnit(extractFinalClickFeatures(samples));
      allUnit(extractOptInClickFeatures(samples));
    }
    expect(Object.values(CLICK_OPT_IN_FEATURE_WEIGHTS).every((w) => w === 0)).toBe(true);
    expect(Object.isFrozen(CLICK_OPT_IN_FEATURE_WEIGHTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCROLL — L104 .. L112
// ---------------------------------------------------------------------------

describe("checklist SCROLL · escenarios realistas", () => {
  it("L104 Velocidad del scroll: bot 12.5 px/ms -> alto; humano 0.04 px/ms -> bajo", () => {
    const fast = scrollSpeed(botFastScroll());
    const slow = scrollSpeed(scrollSamples([8, 9, 7, 10, 8], [0, 200, 400, 600, 800]));
    unit(fast);
    unit(slow);
    // Umbral: <=1 px/ms -> 0, >=8 px/ms -> 1.
    expect(fast).toBe(1);
    expect(slow).toBe(0);
  });

  it("L104b Bot en saltos de 100 px a intervalos exactos: ritmo alto aunque la velocidad es baja", () => {
    // 100 px / 100 ms = 1 px/ms => scrollSpeed=0 (velocidad real baja); el bot
    // se detecta por intervalRegularity/roundDeltas/noPauses, no por velocidad.
    const bot = botExactScroll();
    unit(scrollSpeed(bot));
    expect(scrollSpeed(bot)).toBe(0);
    expect(scrollIntervalRegularity(bot)).toBe(1);
    expect(scrollRoundDeltas(bot)).toBe(1);
    expect(scrollNoPauses(bot)).toBe(1);
    expect(scrollNoOtherMovement(bot)).toBe(1);
  });

  it("L105 Inercia del trackpad: humano desacelera -> bajo; bot sin desacelerar -> alto", () => {
    const human = scrollDecelerationProfile(humanTrackpadScroll());
    const bot = scrollDecelerationProfile(botNoDecelerationScroll());
    unit(human);
    unit(bot);
    // Umbral: cola/cabeza >=0.95 (y suave) -> 1, <=0.5 -> 0.
    expect(human).toBe(0);
    expect(bot).toBe(1);
  });

  it("L106 Pasos de la rueda: bot regulares y redondos -> alto; humano con ruido -> bajo", () => {
    const bot = botExactScroll();
    // Rueda/trackpad humano: magnitudes muy dispares (13-124 px), típicas de
    // un gesto con inercia; no son múltiplos de 50.
    const human = humanReadingScroll();
    unit(scrollDeltaUniformity(bot));
    unit(scrollDeltaUniformity(human));
    unit(scrollRoundDeltas(bot));
    unit(scrollRoundDeltas(human));
    expect(scrollDeltaUniformity(bot)).toBeGreaterThan(0.9);
    expect(scrollDeltaUniformity(human)).toBeLessThan(0.4);
    expect(scrollRoundDeltas(bot)).toBe(1);
    expect(scrollRoundDeltas(human)).toBe(0);
  });

  it("L107 Saltos exactos a posiciones: bot 400 px -> alto; humano rueda fina -> bajo", () => {
    const bot = botJumpScroll();
    const human = humanReadingScroll();
    unit(scrollLargeJumps(bot));
    unit(scrollLargeJumps(human));
    // Umbral: ratio de |dy|>=300 px, >=0.95 -> 1, <=0.5 -> 0 (mínimo 2 saltos).
    expect(scrollLargeJumps(bot)).toBe(1);
    expect(scrollLargeJumps(human)).toBe(0);
  });

  it("L108 Scroll arriba y abajo: bot una dirección -> alto; humano revierte -> bajo", () => {
    const bot = scrollDirectionChanges(botExactScroll());
    const human = scrollDirectionChanges(humanReadingScroll());
    unit(bot);
    unit(human);
    // Umbral: ratio de reversiones de signo, <=0.05 -> 1, >=0.35 -> 0.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L109 Pausas para leer: bot continuo -> alto; humano con pausas -> bajo", () => {
    const bot = scrollNoPauses(botExactScroll());
    const humanUpDown = scrollNoPauses(humanUpDownScroll());
    const humanReading = scrollNoPauses(humanReadingScroll());
    unit(bot);
    unit(humanUpDown);
    unit(humanReading);
    // Umbral: pausas >2x mediana (y >=150 ms), ratio 0 -> 1, >=0.3 -> 0.
    expect(bot).toBe(1);
    expect(humanUpDown).toBeLessThan(0.4);
    expect(humanReading).toBeLessThan(0.4);
  });

  it("L110 Scroll proporcional al contenido: salto fijo -> alto; delta creciente -> bajo", () => {
    const bot = scrollProportional(scrollSamples([400, 400, 400, 400, 400], [0, 20, 40, 60, 80]));
    const human = scrollProportional(humanProportionalScroll());
    unit(bot);
    unit(human);
    // Umbral: |correlación(|dy|, intervalo)|, 0 -> 1 (IA), >=0.5 -> 0.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L111 Scroll sin otro movimiento: bot intervalos exactos -> alto; humano jitter -> bajo", () => {
    const bot = scrollNoOtherMovement(
      scrollSamples([100, 100, 100, 100, 100], [0, 20, 40, 60, 80]),
    );
    const human = scrollNoOtherMovement(humanJitterScroll());
    unit(bot);
    unit(human);
    // Umbral: CV de intervalos, <=0.03 -> 1 (IA), >=0.2 -> 0.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("L112 Scroll instantáneo hasta el final: salto único -> alto; gradual -> bajo", () => {
    const bot = scrollInstantEnd(botInstantEndScroll());
    const human = scrollInstantEnd(humanReadingScroll());
    unit(bot);
    unit(human);
    // Umbral: ratio de trazos <=2 eventos con >=1000 px; 0 -> 0, >=0.5 -> 1.
    expect(bot).toBe(1);
    expect(human).toBe(0);
  });

  it("Autoscroll (botón medio) se excluye: todas las medidas quedan neutras", () => {
    const samples = humanAutoscroll();
    allUnit(extractScrollFeatures(samples));
    allUnit(extractPartialScrollFeatures(samples));
    allUnit(extractFinalScrollFeatures(samples));
    for (const value of Object.values(extractScrollFeatures(samples))) {
      expect(value).toBe(SCROLL_NEUTRAL);
    }
  });

  it("L104-L112 · extractores: todas las medidas finitas en [0,1]", () => {
    for (const samples of [
      humanReadingScroll(),
      botExactScroll(),
      humanTrackpadScroll(),
      botJumpScroll(),
      humanUpDownScroll(),
      botInstantEndScroll(),
    ]) {
      allUnit(extractScrollFeatures(samples));
      allUnit(extractPartialScrollFeatures(samples));
      allUnit(extractFinalScrollFeatures(samples));
    }
  });
});

// ---------------------------------------------------------------------------
// Casos límite reales: sintéticos (trusted=0), duración/deltas cero, valores
// enormes, ráfagas y señales intercaladas. Ninguna medida debe salir de [0,1].
// ---------------------------------------------------------------------------

describe("checklist CLICKS/SCROLL · casos límite reales", () => {
  it("trusted=0 (eventos sintéticos): medidas finitas, sin distinción de confianza", () => {
    const fake = clickSamples(
      Array.from({ length: 5 }, (_, i) => ({
        x: 500,
        y: 300,
        down: 100 + i * 100,
        up: 100 + i * 100 + 60,
        trusted: 0 as const,
      })),
    );
    allUnit(extractClickFeatures(fake));
    allUnit(extractPartialClickFeatures(fake));
    allUnit(extractFinalClickFeatures(fake));
    allUnit(extractOptInClickFeatures(fake));

    const fakeScroll = scrollSamples([100, 100, 100, 100], [0, 16, 32, 48], {
      trusted: 0,
    });
    allUnit(extractScrollFeatures(fakeScroll));
    allUnit(extractPartialScrollFeatures(fakeScroll));
    allUnit(extractFinalScrollFeatures(fakeScroll));
  });

  it("clics de longitud cero (down==up en tiempo y posición): finitos e instantáneos", () => {
    const zero = clickSamples(
      Array.from({ length: 4 }, (_, i) => ({
        x: 10,
        y: 20,
        down: 100 + i * 80,
        up: 100 + i * 80,
      })),
    );
    allUnit(extractClickFeatures(zero));
    allUnit(extractFinalClickFeatures(zero));
    expect(clickInstantaneous(zero)).toBe(1);
  });

  it("deltas de scroll cero: finitos (sin desplazamiento no hay patrón de IA)", () => {
    const zero = scrollSamples([0, 0, 0, 0], [0, 20, 40, 60]);
    allUnit(extractScrollFeatures(zero));
    allUnit(extractPartialScrollFeatures(zero));
    allUnit(extractFinalScrollFeatures(zero));
  });

  it("deltas enormes (1e9): acotados, finitos y en [0,1]", () => {
    const huge = scrollSamples([1e9, -1e9, 1e9, -1e9], [0, 10, 20, 30], {
      dx: [1e9, -1e9, 1e9, -1e9],
    });
    allUnit(extractScrollFeatures(huge));
    allUnit(extractPartialScrollFeatures(huge));
    allUnit(extractFinalScrollFeatures(huge));
    const hugeClicks = clickSamples(
      Array.from({ length: 4 }, (_, i) => ({
        x: 1e9 * (i % 2 ? -1 : 1),
        y: 1e9,
        down: 1e9 + i * 100,
        up: 1e9 + i * 100 + 60,
      })),
    );
    allUnit(extractClickFeatures(hugeClicks));
    allUnit(extractFinalClickFeatures(hugeClicks));
  });

  it("ráfaga de clics a 5 ms: finita y detectada como bot", () => {
    const burst = clickSamples(
      Array.from({ length: 30 }, (_, i) => ({
        x: 300,
        y: 200,
        down: i * 5,
        up: i * 5 + 2,
      })),
    );
    allUnit(extractClickFeatures(burst));
    expect(clickBurstiness(burst)).toBe(1);
    expect(clickConsecutiveSpeed(burst)).toBe(1);
  });

  it("señales intercaladas (botón medio de autoscroll) no contaminan el clic", () => {
    const primary = botGridClicks();
    const interleaved = [
      ...primary.slice(0, 4),
      { seq: 99, x: 0, y: 0, t: 250, kind: 0 as const, button: 1, trusted: 1 as const },
      { seq: 100, x: 999, y: 999, t: 3000, kind: 1 as const, button: 1, trusted: 1 as const },
      ...primary.slice(4),
    ].sort((a, b) => a.t - b.t);
    expect(extractClickFeatures(interleaved)).toEqual(extractClickFeatures(primary));
    allUnit(extractClickFeatures(interleaved));
  });
});
