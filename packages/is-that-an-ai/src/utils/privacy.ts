// Utilidades de privacidad compartidas por los colectores de teclado y texto.
// Funciones puras: NO acceden a window/document/navigator al importar y NO
// leen valores de campos. Se invocan SOLO desde dentro de un listener.

interface SensitiveTargetLike {
  tagName?: unknown;
  type?: unknown;
  getAttribute?: (name: string) => unknown;
}

/**
 * Campos sensibles: `input[type=password]` y equivalentes. Se miran únicamente
 * el nombre de la etiqueta y el atributo `type`; NUNCA se lee `.value`.
 *
 * Un `target` hostil (getters que lanzan, Proxy, objeto parcial) no puede
 * derribar el listener: cualquier fallo al inspeccionarlo se resuelve como
 * "sensible" (fail-closed) para que el evento se descarte sin leer contenido.
 */
export function isSensitiveTarget(event: Event): boolean {
  try {
    const node = event.target as SensitiveTargetLike | null;
    if (!node || typeof node !== "object") return false;
    const tagValue = node.tagName;
    const tag = typeof tagValue === "string" ? tagValue.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea") return false;
    const typeValue = node.type;
    const type = typeof typeValue === "string" ? typeValue.toLowerCase() : "";
    if (type === "password") return true;
    const getAttribute = node.getAttribute;
    const attribute = typeof getAttribute === "function" ? getAttribute.call(node, "type") : null;
    return typeof attribute === "string" && attribute.toLowerCase() === "password";
  } catch {
    // No se puede demostrar que no es sensible: se descarta el evento.
    return true;
  }
}
