// Última posición conocida del puntero, para situar el círculo de reveal.
// Se reutiliza el mismo objeto: setCursorPos se llama en cada pointermove y
// crear un objeto nuevo en cada evento solo generaba trabajo para el GC.
// getCursorPos devuelve el objeto compartido; los consumidores lo copian.

const cursorPos = { x: 0, y: 0 };
let hasPos = false;

export function setCursorPos(x: number, y: number): void {
  cursorPos.x = x;
  cursorPos.y = y;
  hasPos = true;
}

export function getCursorPos(): { x: number; y: number } {
  if (hasPos) return cursorPos;
  if (typeof window !== "undefined") {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return { x: 0, y: 0 };
}
