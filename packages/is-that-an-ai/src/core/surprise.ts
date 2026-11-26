// Coherencia "sorpresa": combina los scores ya calculados para detectar
// mezclas imposibles de personalidades en la MISMA sesión. Función pura sobre
// números y booleanos: sin DOM, sin red, sin storage y sin cadenas de teclas.
//
// Convención del scoring: score 1 = más probable IA, 0 = humano, null = sin evidencia.
// Las bandas son las públicas del scorer (HUMAN_MAX=0.25, AI_MIN=0.55).
// Fail-closed: con menos de dos señales con evidencia NO se acusa nada; un
// score no finito se trata como ausencia de evidencia.
//
// Umbrales documentados: IA cuando score >= 0.55, humano cuando score <= 0.25.
// Cualquier par de señales con evidencia en lados opuestos se rechaza, con el
// par ratón/teclado evaluado primero (es la contradicción canónica).

import { AI_MIN, HUMAN_MAX } from "../scoring/score";

/** Resultado de la comprobación: `passed=false` significa mezcla imposible. */
export interface SurpriseCheck {
  passed: boolean;
  reason: string;
}

export interface SurpriseInput {
  mouseScore: number | null;
  keyboardScore: number | null;
  clickScore: number | null;
  scrollScore: number | null;
  mouseEvidence: boolean;
  keyboardEvidence: boolean;
  clickEvidence: boolean;
  scrollEvidence: boolean;
}

type SignalName = "mouse" | "keyboard" | "click" | "scroll";
const SIGNAL_NAMES: readonly SignalName[] = ["mouse", "keyboard", "click", "scroll"];

const INSUFFICIENT = "evidencia insuficiente para comparar";
const COHERENT = "señales coherentes";
const NEUTRAL = "sin contradicción clara";

/** Orden estable de pares: la contradicción ratón/teclado tiene prioridad. */
const PAIRS: ReadonlyArray<readonly [SignalName, SignalName]> = [
  ["mouse", "keyboard"],
  ["mouse", "click"],
  ["mouse", "scroll"],
  ["keyboard", "click"],
  ["keyboard", "scroll"],
  ["click", "scroll"],
];

function classify(score: number | null): "ai" | "human" | "unclear" {
  if (typeof score !== "number" || !Number.isFinite(score)) return "unclear";
  if (score >= AI_MIN) return "ai";
  if (score <= HUMAN_MAX) return "human";
  return "unclear";
}

/**
 * Comprueba que las señales con evidencia no se contradigan. Devuelve siempre
 * una razón no vacía y nunca lanza, incluso con entradas hostiles.
 */
export function surpriseCoherenceCheck(input: SurpriseInput): SurpriseCheck {
  const source = input as SurpriseInput | null | undefined;
  const scores: Record<SignalName, number | null> = {
    mouse: source?.mouseScore ?? null,
    keyboard: source?.keyboardScore ?? null,
    click: source?.clickScore ?? null,
    scroll: source?.scrollScore ?? null,
  };
  const evidence: Record<SignalName, boolean> = {
    mouse: source?.mouseEvidence === true,
    keyboard: source?.keyboardEvidence === true,
    click: source?.clickEvidence === true,
    scroll: source?.scrollEvidence === true,
  };

  const present = SIGNAL_NAMES.filter(
    (name) => evidence[name] && classify(scores[name]) !== "unclear",
  );
  if (present.length < 2) return { passed: true, reason: INSUFFICIENT };

  for (const [left, right] of PAIRS) {
    if (!evidence[left] || !evidence[right]) continue;
    const a = classify(scores[left]);
    const b = classify(scores[right]);
    if ((a === "ai" && b === "human") || (a === "human" && b === "ai")) {
      return {
        passed: false,
        reason: `${left}-${right}: señales contradictorias (IA vs humano)`,
      };
    }
  }

  const kinds = new Set(present.map((name) => classify(scores[name])));
  return {
    passed: true,
    reason: kinds.size === 1 ? COHERENT : NEUTRAL,
  };
}
