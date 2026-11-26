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
 */
export function isSensitiveTarget(event: Event): boolean {
  const node = event.target as SensitiveTargetLike | null;
  if (!node || typeof node !== "object") return false;
  const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
  if (tag !== "input" && tag !== "textarea") return false;
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
  if (type === "password") return true;
  const attribute = typeof node.getAttribute === "function" ? node.getAttribute("type") : null;
  return typeof attribute === "string" && attribute.toLowerCase() === "password";
}
