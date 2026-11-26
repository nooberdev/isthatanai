// Etapa 11 — adaptador de ciclo de vida para Svelte.
// NO importa Svelte: es solo un adaptador de ciclo de vida; el componente
// decide cuándo llamar a start()/stop() (p. ej. onMount / onDestroy).
// Sin dependencias de framework ni de bundler.

import type { IsThatAnAI } from "../core/detector";
import type { DetectorOptions } from "../types";
import { createDetectorHandle } from "./react";

/** Crea un detector para usar desde un componente de Svelte. */
export function createSvelteDetector(options?: DetectorOptions): {
  start(): void;
  stop(): void;
  instance: IsThatAnAI;
} {
  return createDetectorHandle(options);
}
