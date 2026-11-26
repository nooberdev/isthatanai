// Etapa 11 — arranque automático opcional.
//
// El constructor de `IsThatAnAI` NUNCA consulta `window`/`document`/`navigator`
// (regla SSR del proyecto). Por eso la opción `autoStart` de `DetectorOptions`
// es declarativa: documenta la intención, pero NO puede iniciar nada por sí
// misma. El arranque real vive en este helper, que es el único lugar que
// comprueba el DOM en runtime y llama a `start()`. Así se conserva intacta la
// importación en servidor (sin globals) y se mantiene una sola ruta de arranque.

import { IsThatAnAI } from "./core/detector";
import type { DetectorOptions } from "./types";

/**
 * Crea y arranca un detector solo cuando existe un DOM. Sin `document`
 * (SSR / tests de importación) devuelve `null` sin tocar ningún global.
 */
export function autoStart(options: DetectorOptions = {}): IsThatAnAI | null {
  if (typeof document === "undefined") return null;
  try {
    const detector = new IsThatAnAI(options);
    detector.start();
    return detector;
  } catch {
    // Un DOM hostil (getters que lanzan, etc.) no debe romper la carga.
    return null;
  }
}
