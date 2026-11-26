// Etapa 11 — adaptador de ciclo de vida para React (y helper interno compartido).
// NO es un hook de React ni importa React: es solo un adaptador de ciclo de
// vida; el componente decide cuándo llamar a start()/stop() (p. ej. useEffect).
// Sin dependencias de framework ni de bundler.

import { IsThatAnAI } from "../core/detector";
import type { DetectorOptions } from "../types";

/** Manejador mínimo devuelto por todos los adaptadores. */
export interface DetectorHandle {
  start(): void;
  stop(): void;
  instance: IsThatAnAI;
}

/** Helper interno compartido por los adaptadores React/Svelte/Vue. */
export function createDetectorHandle(options?: DetectorOptions): DetectorHandle {
  const instance = new IsThatAnAI(options);
  return {
    instance,
    start(): void {
      instance.start();
    },
    stop(): void {
      instance.stop();
    },
  };
}

/** Crea un detector para usar desde un componente de React. */
export function createReactDetector(options?: DetectorOptions): DetectorHandle {
  return createDetectorHandle(options);
}
