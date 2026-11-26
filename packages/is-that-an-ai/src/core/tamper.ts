// Chequeos de integridad en runtime: comprobaciones honestas de la superficie
// pública, de que las tablas de pesos siguen congeladas, de que los umbrales
// siguen siendo sanos y de que el reloj disponible es utilizable.
//
// SIN ofuscación, SIN constantes secretas, SIN `eval`/`Function`, SIN DOM al
// importar, SIN red y SIN storage. Un API ausente o parcheado se informa como
// `ok:false`: nada de aquí intenta "arreglar" ni ocultar el fallo.
// La huella es un checksum FNV-1a de la configuración pública estática, no un
// secreto: sirve para comparar despliegues, no para autenticar nada.

import {
  AI_CONFIRM_MS,
  AI_CORE,
  AI_MIN,
  computeScore,
  DEFAULT_SCORING_CONFIG,
  EMA_ALPHA,
  HUMAN_CONFIRM_MS,
  HUMAN_CORE,
  HUMAN_MAX,
  SCORED_SIGNALS,
  SENSITIVITY_PRESETS,
  SIGNAL_DIFFICULTY,
  SIGNAL_WEIGHTS,
} from "../scoring/score";
import { weights } from "../scoring/weights";
import { clamp } from "../utils/math";
import { evaluateCoherence } from "./coherence";
import { declaredVsBehavior, humanizationRisk, injectionRisk } from "./injection";

/** Informe acumulativo: `ok` es verdadero solo si TODAS las comprobaciones pasan. */
export interface IntegrityReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean }>;
}

type Check = { name: string; ok: boolean };

/** Ejecuta una comprobación sin dejar que un getter/proxy hostil la rompa. */
function guard(name: string, probe: () => boolean): Check {
  try {
    return { name, ok: probe() === true };
  } catch {
    return { name, ok: false };
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function usableClock(): boolean {
  const clock = globalThis as unknown as {
    performance?: unknown;
    Date?: unknown;
  };
  const perf = isObject(clock.performance) ? (clock.performance as { now?: unknown }) : undefined;
  const performanceNow = perf?.now;
  const dateObject =
    typeof clock.Date === "function" ? (clock.Date as { now?: unknown }) : undefined;
  const dateNow = dateObject?.now;
  const read = (): number => {
    if (typeof performanceNow === "function") {
      const value = (performanceNow as () => unknown).call(perf);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    if (typeof dateNow === "function") {
      const value = (dateNow as () => unknown).call(dateObject);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return Number.NaN;
  };
  const first = read();
  const second = read();
  // Dos lecturas finitas y no retrógradas: reloj roto -> no hay evidencia.
  return Number.isFinite(first) && Number.isFinite(second) && second >= first;
}

/**
 * Verifica la integridad del entorno de la librería. Nunca lanza: cualquier
 * API ausente, parcheada o con valores imposibles aparece como `ok:false`.
 */
export function verifyIntegrity(): IntegrityReport {
  const checks: Check[] = [
    guard("api-surface", () => {
      const performance = (globalThis as { performance?: unknown }).performance;
      const perfOk =
        isObject(performance) && typeof (performance as { now?: unknown }).now === "function";
      return (
        typeof evaluateCoherence === "function" &&
        typeof injectionRisk === "function" &&
        typeof humanizationRisk === "function" &&
        typeof declaredVsBehavior === "function" &&
        typeof computeScore === "function" &&
        typeof clamp === "function" &&
        isObject(SIGNAL_WEIGHTS) &&
        isObject(DEFAULT_SCORING_CONFIG) &&
        isObject(SENSITIVITY_PRESETS) &&
        typeof globalThis.Date === "function" &&
        (perfOk || typeof globalThis.Date.now === "function")
      );
    }),
    guard("weights-frozen", () =>
      [
        SIGNAL_WEIGHTS,
        SIGNAL_DIFFICULTY,
        SCORED_SIGNALS,
        SENSITIVITY_PRESETS,
        weights,
        DEFAULT_SCORING_CONFIG.signalWeights,
      ].every((table) => Object.isFrozen(table)),
    ),
    guard("weights-sane", () => {
      const values = Object.values(SIGNAL_WEIGHTS);
      let sum = 0;
      for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
        sum += value;
      }
      return values.length > 0 && Number.isFinite(sum) && sum > 0;
    }),
    guard("thresholds-sane", () => {
      const inUnit = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
      const normal = SENSITIVITY_PRESETS.normal;
      return (
        inUnit(HUMAN_MAX) &&
        inUnit(AI_MIN) &&
        inUnit(HUMAN_CORE) &&
        inUnit(AI_CORE) &&
        HUMAN_MAX < AI_MIN &&
        HUMAN_CORE <= HUMAN_MAX &&
        AI_CORE >= AI_MIN &&
        Number.isFinite(EMA_ALPHA) &&
        EMA_ALPHA >= 0 &&
        EMA_ALPHA <= 1 &&
        Number.isFinite(HUMAN_CONFIRM_MS) &&
        HUMAN_CONFIRM_MS >= 0 &&
        Number.isFinite(AI_CONFIRM_MS) &&
        AI_CONFIRM_MS >= 0 &&
        clamp(HUMAN_MAX, 0, 1) === HUMAN_MAX &&
        inUnit(normal.thresholds.humanMax) &&
        inUnit(normal.thresholds.aiMin) &&
        normal.thresholds.humanMax < normal.thresholds.aiMin
      );
    }),
    guard("clock-usable", () => usableClock()),
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

/** FNV-1a de 32 bits sobre la configuración pública estática (8 hex). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Huella determinista de la configuración verificable. No incluye el reloj
 * (cambia en cada lectura) ni nada secreto: solo pesos, umbrales y flags de
 * congelación. Devuelve siempre 8 caracteres hexadecimales.
 */
export function integrityFingerprint(): string {
  try {
    const parts: string[] = [];
    for (const key of Object.keys(SIGNAL_WEIGHTS).sort()) {
      const value = SIGNAL_WEIGHTS[key as keyof typeof SIGNAL_WEIGHTS];
      parts.push(`${key}:${String(value)}`);
    }
    parts.push(
      `humanMax:${String(HUMAN_MAX)}`,
      `aiMin:${String(AI_MIN)}`,
      `ema:${String(EMA_ALPHA)}`,
      `humanMs:${String(HUMAN_CONFIRM_MS)}`,
      `aiMs:${String(AI_CONFIRM_MS)}`,
      `frozen:${Object.isFrozen(SIGNAL_WEIGHTS) ? 1 : 0}`,
      `frozenDefault:${Object.isFrozen(DEFAULT_SCORING_CONFIG) ? 1 : 0}`,
    );
    return fingerprint(parts.join("|"));
  } catch {
    return fingerprint("unavailable");
  }
}
