// Pesos de las medidas de mouse en el scoring.
//
// Cada peso es una evidencia ponderada: score = sum(w * f) / sum(w).
// No se exige que sumen 1; se normaliza por la suma de pesos usados.
// Valores más altos = más peso en el veredicto.

import type { MouseFeatures } from "../features/mouse";

/** Pesos documentados por medida (en orden de `extractMouseFeatures`). */
export const weights = {
  /** Rectitud: peso mínimo, un humano también va en línea recta al borde. */
  straightness: 0.04,
  /** Salto imposible en un evento: la señal fuerte de agente. */
  teleport: 0.6,
  /** Velocidad constante: poca prueba, un humano también la mantiene. */
  speedUniformity: 0.06,
  /** Jerk: variabilidad del cambio de velocidad. */
  jerk: 0.03,
  /** Poco temblor: apenas peso, el hardware ya suaviza el mouse. */
  tremor: 0.02,
  /** Intervalos regulares: peso bajo, el SO emite a 60 Hz. */
  intervalRegularity: 0.02,
  /** Correcciones/reversiones: humano, se invierte al sumar. */
  overshoot: 0.05,
  /** Giros suaves: humano, se invierte al sumar. */
  turnSmoothness: 0.08,
  /** Sin pausas: apenas peso, un humano puede no pausar. */
  microPauses: 0.02,
  /** Pasos redondos: señal débil, clientX/y suelen ser enteros. */
  roundSteps: 0.08,
} as const satisfies Readonly<Record<keyof MouseFeatures, number>>;

export type FeatureWeights = typeof weights;
