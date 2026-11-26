// Proyección del camino del mouse, compartida por el visualizador. Misma
// escala para X e Y: el trazo no se deforma aunque la ventana sea ancha.

import type { PointerSample } from "is-that-an-ai";

export const VIEW_W = 100;
export const VIEW_H = 62;
const PAD = 6;

export interface PathFrame {
  start: { x: number; y: number };
  end: { x: number; y: number };
  path: string[];
}

export function frameOf(samples: PointerSample[]): PathFrame | null {
  if (samples.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of samples) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.max(spanX / (VIEW_W - PAD * 2), spanY / (VIEW_H - PAD * 2));
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const ox = (VIEW_W - spanX * safeScale) / 2 - minX * safeScale;
  const oy = (VIEW_H - spanY * safeScale) / 2 - minY * safeScale;
  const project = (p: PointerSample) => ({ x: p.x * safeScale + ox, y: p.y * safeScale + oy });
  return {
    start: project(samples[0]),
    end: project(samples[samples.length - 1]),
    path: samples.map((p) => {
      const q = project(p);
      return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
    }),
  };
}

export function spanLabel(samples: PointerSample[]): string {
  if (samples.length < 2) return "—";
  return `${((samples[samples.length - 1].t - samples[0].t) / 1000).toFixed(1)} s`;
}
