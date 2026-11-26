// Etapa 11 — modo script global.
// Sin acceso a window/document/navigator al importar: el DOM solo se toca
// dentro de installGlobal(), que falla con un error claro en SSR.

import { IsThatAnAI } from "./core/detector";

/** Nombre por defecto del global cuando no se especifica otro. */
export const DEFAULT_GLOBAL_NAME = "isThatAnAI";

/**
 * Crea un detector y lo expone en `window[name ?? "isThatAnAI"]`.
 * No inicia la captura automáticamente: el llamador decide cuándo `start()`.
 *
 * SSR-safe: lanza un Error descriptivo si no existe `window` en tiempo de
 * ejecución, en lugar de tocar un global inexistente al importar el módulo.
 */
export function installGlobal(name?: string): IsThatAnAI {
  if (typeof window === "undefined") {
    throw new Error("installGlobal requiere un entorno de navegador: no existe window (SSR).");
  }
  const key = name ?? DEFAULT_GLOBAL_NAME;
  const detector = new IsThatAnAI();
  (window as unknown as Record<string, IsThatAnAI>)[key] = detector;
  return detector;
}
