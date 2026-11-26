// Señales del ENTORNO (checklist L148, L151-L154). Funciones puras y
// deterministas: SOLO números de las muestras más pistas (`hints`) inyectadas
// por el detector en tiempo de ejecución.
//
// REGLA SSR/PRIVACIDAD: aquí no se lee `window`, `document`, `navigator` ni
// ningún global en el ámbito del módulo; tampoco se hace red, storage ni se
// guarda texto. El detector es el único que puede pasar `hints` (por ejemplo,
// `navigator.webdriver` o `userAgent`) ya obtenidos en `start()`.
//
// Todas las medidas están en [0,1] (1 = más sospechoso). 0 = "no aparece el
// patrón", NO "humano". Los valores no finitos se descartan (fail-closed).
// Las señales son ADITIVAS: no tocan el score calibrado ni el veredicto.
//
// Umbrales documentados:
// - L148 `automatedBrowser`: `hints.webdriver === true` -> 1. Si no, se cuentan
//   marcadores de UA automatizado/headless ("headless", "webdriver",
//   "automation", "headlesschrome", "phantom"): 1 marca -> 0.75, >=2 -> 1.
//   Contradicción móvil (`mobile === true` con `maxTouchPoints === 0`) -> 0.8.
// - L151 `oddViewport`: tamaño no finito -> 0 (sin evidencia). Finito pero
//   degenerado (<200 o >8192 en cualquier eje, o <=0) -> 1. Coincidencia exacta
//   con viewports por defecto de headless (800x600, 1024x768, 1280x720,
//   1280x800) -> 1; a +-2px -> 0.6. Proporción extrema (>3.5 o <1/3.5) sin
//   ser móvil -> 0.7.
// - L152 `noMovement`: requiere >=8 eventos con spanning >=1000ms y CERO
//   muestras de movimiento de puntero (kind 0 o cualquier puntero no-mouse).
//   Crece con el número de eventos: 8 -> 0, >=40 -> 1.
// - L153 `noNormalEvents`: con >=8 eventos, mide cuántos de los 5 flujos
//   (puntero/clic/scroll/tecla/texto) tienen muestra. 1 flujo -> 1,
//   2 -> ~0.67, 3 -> ~0.33, >=4 -> 0.
// - L154 `agentTools`: marcadores de UA de herramientas conocidas (Selenium,
//   Puppeteer, Playwright, drivers, jsdom, clientes HTTP tipo python-requests,
//   curl, wget, axios...). 1 marca -> 0.75, >=2 -> 1. Se solapa parcialmente
//   con L148 a propósito: L148 mira la MARCA DE NAVEGADOR, L154 la HERRAMIENTA.

import type { ClickSample, InputSample, KeySample, PointerSample, ScrollSample } from "../types";
import { clamp, linear } from "../utils/math";

/** Cinco señales de entorno, cada una en [0,1] (1 = más sospechoso). */
export interface EnvironmentSignals {
  /** L148: navegador automatizado (flag/pistas de UA inyectadas). */
  automatedBrowser: number;
  /** L151: tamaño de ventana raro/típico de bots. */
  oddViewport: number;
  /** L152: sesión larga sin ningún movimiento de puntero. */
  noMovement: number;
  /** L153: sesión con demasiados pocos flujos de eventos normales. */
  noNormalEvents: number;
  /** L154: herramientas conocidas de agentes en el UA inyectado. */
  agentTools: number;
}

/**
 * Pistas OPCIONALES que el detector recoge en runtime (nunca aquí). Todo lo
 * que no sea del tipo esperado se ignora: no es evidencia en ningún sentido.
 */
export interface EnvironmentHints {
  webdriver?: boolean;
  maxTouchPoints?: number;
  screenWidth?: number;
  screenHeight?: number;
  mobile?: boolean;
  userAgent?: string;
}

const AUTOMATION_MARKERS: readonly string[] = [
  "headless",
  "webdriver",
  "automation",
  "headlesschrome",
  "phantom",
];
const AGENT_MARKERS: readonly string[] = [
  "selenium",
  "puppeteer",
  "playwright",
  "chromedriver",
  "geckodriver",
  "jsdom",
  "nightmare",
  "python-requests",
  "python-urllib",
  "axios",
  "node-fetch",
  "postmanruntime",
  "curl/",
  "wget/",
  "undici",
];
const KNOWN_HEADLESS_VIEWPORTS: ReadonlySet<string> = new Set([
  "800x600",
  "1024x768",
  "1280x720",
  "1280x800",
]);
const MIN_VIEWPORT_PX = 200;
const MAX_VIEWPORT_PX = 8192;
const VIEWPORT_NEAR_PX = 2;
const EXTREME_ASPECT = 3.5;
const MIN_MOVEMENT_EVENTS = 8;
const MOVEMENT_FULL_EVENTS = 40;
const MIN_MOVEMENT_SPAN_MS = 1000;
const MIN_NORMAL_EVENTS = 8;

/** Resultado siempre finito en [0,1]. */
function safe01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/** Solo números finitos; NaN/Infinity/cadenas no son evidencia. */
function envFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** UA inyectado, en minúsculas; ausente/no cadena => cadena vacía. */
function envUserAgent(hints: EnvironmentHints | undefined): string {
  return typeof hints?.userAgent === "string" ? hints.userAgent.toLowerCase() : "";
}

/** Número de marcadores DISTINTOS presentes (evita contar dos veces "headless"). */
function envMarkerCount(ua: string, markers: readonly string[]): number {
  let count = 0;
  for (const marker of markers) if (ua.includes(marker)) count += 1;
  return count;
}

/** Un marcador -> 0.75; dos o más -> 1; ninguno -> 0. */
function envMarkerScore(count: number): number {
  if (count <= 0) return 0;
  return count >= 2 ? 1 : 0.75;
}

/** L148. Nunca lee globals: todo viene de `hints`. */
function envAutomatedBrowser(hints: EnvironmentHints | undefined): number {
  if (!hints) return 0;
  let score =
    hints.webdriver === true
      ? 1
      : envMarkerScore(envMarkerCount(envUserAgent(hints), AUTOMATION_MARKERS));
  const touch = envFinite(hints.maxTouchPoints);
  // Un UA móvil que declara cero puntos táctiles es típico de headless.
  if (hints.mobile === true && touch !== null && touch === 0) score = Math.max(score, 0.8);
  return safe01(score);
}

/** L151. Mide rareza del viewport inyectado, sin suponer nada del dispositivo real. */
function envOddViewport(hints: EnvironmentHints | undefined): number {
  const width = envFinite(hints?.screenWidth);
  const height = envFinite(hints?.screenHeight);
  if (width === null || height === null) return 0;
  if (width <= 0 || height <= 0) return 1;
  if (
    width < MIN_VIEWPORT_PX ||
    height < MIN_VIEWPORT_PX ||
    width > MAX_VIEWPORT_PX ||
    height > MAX_VIEWPORT_PX
  ) {
    return 1;
  }
  for (const known of KNOWN_HEADLESS_VIEWPORTS) {
    const [kw, kh] = known.split("x").map(Number);
    if (width === kw && height === kh) return 1;
  }
  for (const known of KNOWN_HEADLESS_VIEWPORTS) {
    const [kw, kh] = known.split("x").map(Number);
    if (Math.abs(width - kw) <= VIEWPORT_NEAR_PX && Math.abs(height - kh) <= VIEWPORT_NEAR_PX) {
      return 0.6;
    }
  }
  // Proporción extrema en escritorio: tamaño "raro" y útil como proxy débil.
  if (hints?.mobile !== true) {
    const aspect = width / height;
    if (aspect > EXTREME_ASPECT || aspect < 1 / EXTREME_ASPECT) return 0.7;
  }
  return 0;
}

interface EnvStreamSummary {
  total: number;
  first: number;
  last: number;
}

/** Resumen de marcas finitas de un flujo, sin ordenar ni mutar nada. */
function envSummarize(values: Array<{ t: number }> | undefined): EnvStreamSummary {
  const summary: EnvStreamSummary = { total: 0, first: Infinity, last: -Infinity };
  if (!Array.isArray(values)) return summary;
  for (const value of values) {
    const t = envFinite(value?.t);
    if (t === null) continue;
    summary.total += 1;
    if (t < summary.first) summary.first = t;
    if (t > summary.last) summary.last = t;
  }
  return summary;
}

/** L152. Cuenta movimientos reales (kind 0 o puntero no-mouse). */
function envNoMovement(points: PointerSample[], streams: EnvStreamSummary[]): number {
  const total = streams.reduce((sum, stream) => sum + stream.total, 0);
  if (total === 0) return 0;
  let first = Infinity;
  let last = -Infinity;
  for (const stream of streams) {
    if (stream.first < first) first = stream.first;
    if (stream.last > last) last = stream.last;
  }
  const span = last - first;
  if (!Number.isFinite(span) || span < MIN_MOVEMENT_SPAN_MS) return 0;
  let movements = 0;
  if (Array.isArray(points)) {
    for (const point of points) {
      const t = envFinite(point?.t);
      if (t === null) continue;
      if (point.kind === 0 || point.pointerType !== 0) movements += 1;
    }
  }
  if (movements > 0) return 0;
  return safe01(linear(total, MIN_MOVEMENT_EVENTS, MOVEMENT_FULL_EVENTS));
}

/** L153. Diversidad de flujos: un navegador normal genera varios a la vez. */
function envNoNormalEvents(streams: EnvStreamSummary[]): number {
  const total = streams.reduce((sum, stream) => sum + stream.total, 0);
  if (total < MIN_NORMAL_EVENTS) return 0;
  const active = streams.filter((stream) => stream.total > 0).length;
  return safe01(1 - linear(active, 1, 4));
}

/** L154. Solo UA inyectado; jamás `navigator` directo. */
function envAgentTools(hints: EnvironmentHints | undefined): number {
  return safe01(envMarkerScore(envMarkerCount(envUserAgent(hints), AGENT_MARKERS)));
}

/**
 * Evalúa las cinco señales de entorno. `hints` y las listas vienen del detector
 * en runtime; con todo vacío (y sin pistas) devuelve 0/0/0/0/0.
 */
export function evaluateEnvironment(input: {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
  hints?: EnvironmentHints;
}): EnvironmentSignals {
  const hints = input?.hints;
  const points = Array.isArray(input?.points) ? input.points : [];
  const clicks = Array.isArray(input?.clicks) ? input.clicks : [];
  const scrolls = Array.isArray(input?.scrolls) ? input.scrolls : [];
  const keys = Array.isArray(input?.keys) ? input.keys : [];
  const inputs = Array.isArray(input?.inputs) ? input.inputs : [];
  const streams = [
    envSummarize(points),
    envSummarize(clicks),
    envSummarize(scrolls),
    envSummarize(keys),
    envSummarize(inputs),
  ];
  return {
    automatedBrowser: envAutomatedBrowser(hints),
    oddViewport: envOddViewport(hints),
    noMovement: envNoMovement(points, streams),
    noNormalEvents: envNoNormalEvents(streams),
    agentTools: envAgentTools(hints),
  };
}
