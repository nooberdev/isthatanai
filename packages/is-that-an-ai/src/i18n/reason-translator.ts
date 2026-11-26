// Puente entre las razones en español que producen features/scoring y la capa
// i18n. Las funciones de medición siguen emitiendo las cadenas históricas en
// español; aquí se hacen corresponder con su clave de traducción y se emiten
// en el idioma solicitado. SIN acceso al DOM: seguro en SSR.

import { es, type TranslationKey } from "./dictionaries";
import { t } from "./index";
import type { Locale } from "./locales";

/**
 * Mapa invertido: cadena española exacta -> clave del diccionario.
 * Solo se construye a partir de `es`: las traducciones de otros idiomas no
 * participan, de modo que una razón ya traducida no se vuelve a mapear.
 */
const SPANISH_TO_KEY: ReadonlyMap<string, TranslationKey> = new Map(
  (Object.keys(es) as TranslationKey[]).map((key) => [es[key], key]),
);

/**
 * Traduce razones desde su forma española original al `locale` dado.
 *
 * - Correspondencia exacta: la cadena producida por `scoreReasons`,
 *   `clickReasons`, `scrollReasons` o `keyboardReasons` se busca en el mapa
 *   invertido y se resuelve con `t(key, locale)`.
 * - Razones dinámicas con marcadores (`{device}`, `{from}`, `{to}`): el código
 *   que las genera las interpola antes de emitirlas, por lo que no hay clave
 *   exacta y se devuelven tal cual (no se inventa ni se pierde ningún valor).
 * - Cualquier otra cadena desconocida pasa sin cambios.
 *
 * Devuelve siempre un array nuevo; no muta el de entrada.
 */
export function translateReasons(reasons: string[], locale: Locale): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons.map((reason) => {
    const key = SPANISH_TO_KEY.get(reason);
    return key === undefined ? reason : t(key, locale);
  });
}
