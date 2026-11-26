// Privacidad: declaración y aviso, no un escáner.
//
// `privacyAudit()` NO inspecciona el entorno en tiempo de ejecución: los ceros
// son literales de tipo y de valor que documentan una ausencia POR CONSTRUCCIÓN
// (el código nunca llama a la red, nunca escribe almacenamiento, nunca toca
// `document.cookie` y nunca guarda la identidad de una tecla). Es una
// declaración verificable estáticamente, NO un análisis runtime: un cambio que
// introdujera alguna de esas operaciones NO se detectaría escaneando el objeto
// devuelto. Para eso sirve el test estático del código fuente.
//
// SIN DOM al importar, SIN red, SIN almacenamiento, SIN texto de teclas.

/** Aviso corto y veraz que la web puede mostrar si lo desea (L208). */
export const PRIVACY_NOTICE =
  "Este detector solo mide tiempos y magnitudes en tu dispositivo: no envía datos, no usa cookies ni almacenamiento, y nunca guarda qué teclas pulsas ni qué texto escribes.";

/**
 * Declaración de privacidad por construcción (L199, L204). Cero en todo:
 * envío de datos, almacenamiento persistente, cookies y identidades de tecla.
 * Los `0` son literales —no resultado de una medición en runtime—.
 */
export function privacyAudit(): {
  networkCalls: 0;
  persistentStorage: 0;
  cookies: 0;
  keyIdentities: 0;
} {
  return { networkCalls: 0, persistentStorage: 0, cookies: 0, keyIdentities: 0 };
}
