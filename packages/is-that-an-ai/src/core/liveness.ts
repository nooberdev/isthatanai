// Monitor de "latido" (liveness): lógica PURA de reloj. No crea temporizadores,
// no lee `window`/`document`, no hace red ni storage. El llamador decide cuándo
// llamar a `beat(now)` y cuándo consultar `status(now)`.
//
// Fail-closed: sin latido -> `idle`; reloj no finito o retrógrado -> `stale`
// (nunca `live`). Un `beat()` con marca no finita o hacia atrás se ignora.
//
// Umbrales documentados:
// - `intervalMs` default 1000ms, `staleMs` default 5 * intervalMs (5000ms):
//   cinco latidos perdidos consecutivos se consideran "stale".
// - Ambos se acotan a [1, 3600000] ms; `staleMs < intervalMs` se eleva a
//   `intervalMs` para no declarar "stale" entre dos latidos válidos.

import { clamp } from "../utils/math";

export type LivenessStatus = "live" | "stale" | "idle";

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_STALE_FACTOR = 5;
const MAX_MS = 3_600_000;
const MIN_MS = 1;

function positiveMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(Math.floor(value), MIN_MS, MAX_MS);
}

export class LivenessMonitor {
  readonly intervalMs: number;
  readonly staleMs: number;

  private lastBeatAt: number | null = null;

  constructor(options?: { intervalMs?: number; staleMs?: number }) {
    this.intervalMs = positiveMs(options?.intervalMs, DEFAULT_INTERVAL_MS);
    const fallbackStale = clamp(this.intervalMs * DEFAULT_STALE_FACTOR, MIN_MS, MAX_MS);
    const requested = positiveMs(options?.staleMs, fallbackStale);
    this.staleMs = Math.max(requested, this.intervalMs);
  }

  /** Registra un latido. Marcas no finitas o retrógradas se ignoran. */
  beat(now: number): void {
    if (typeof now !== "number" || !Number.isFinite(now)) return;
    if (this.lastBeatAt !== null && now < this.lastBeatAt) return;
    this.lastBeatAt = now;
  }

  /** `idle` sin latidos, `live` dentro de `staleMs`, `stale` en caso contrario. */
  status(now: number): LivenessStatus {
    if (this.lastBeatAt === null) return "idle";
    if (typeof now !== "number" || !Number.isFinite(now) || now < this.lastBeatAt) return "stale";
    const age = now - this.lastBeatAt;
    return Number.isFinite(age) && age <= this.staleMs ? "live" : "stale";
  }
}
