let cursorPos: { x: number; y: number } | null = null;

export function setCursorPos(x: number, y: number): void {
  cursorPos = { x, y };
}

export function getCursorPos(): { x: number; y: number } {
  if (cursorPos) return cursorPos;
  if (typeof window !== "undefined") {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return { x: 0, y: 0 };
}
