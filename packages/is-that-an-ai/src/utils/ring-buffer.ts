// Buffer circular de capacidad fija. Almacena solo números en Float64Array:
// no se asigna ningún objeto por muestra; los PointerSample se crean solo al leer.

import type { PointerSample } from "../types";

const FIELD_COUNT = 7;
const SEQ = 0;
const X = 1;
const Y = 2;
const T = 3;
const KIND = 4;
const POINTER_TYPE = 5;
const TRUSTED = 6;

export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float64Array;
  /** Índice de la muestra más antigua aún válida. */
  private start = 0;
  private count = 0;
  private dropped = 0;

  constructor(capacity = 2048) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
    this.data = new Float64Array(this.capacity * FIELD_COUNT);
  }

  push(
    seq: number,
    x: number,
    y: number,
    t: number,
    kind: number,
    pointerType: number,
    trusted: number,
  ): void {
    // Si está lleno, escribimos sobre la más antigua (que está en `start`).
    const index = (this.start + this.count) % this.capacity;
    const base = index * FIELD_COUNT;
    this.data[base + SEQ] = seq;
    this.data[base + X] = x;
    this.data[base + Y] = y;
    this.data[base + T] = t;
    this.data[base + KIND] = kind;
    this.data[base + POINTER_TYPE] = pointerType;
    this.data[base + TRUSTED] = trusted;

    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.dropped += 1;
    } else {
      this.count += 1;
    }
  }

  /** Copia ordenada de la más antigua a la más reciente. */
  snapshot(): PointerSample[] {
    const result: PointerSample[] = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const base = ((this.start + i) % this.capacity) * FIELD_COUNT;
      result[i] = {
        seq: this.data[base + SEQ],
        x: this.data[base + X],
        y: this.data[base + Y],
        t: this.data[base + T],
        kind: this.data[base + KIND] as PointerSample["kind"],
        pointerType: this.data[base + POINTER_TYPE] as PointerSample["pointerType"],
        trusted: this.data[base + TRUSTED] as 0 | 1,
      };
    }
    return result;
  }

  /** Solo muestras con seq estrictamente mayor que `sinceSeq`. */
  snapshotSince(sinceSeq: number): PointerSample[] {
    return this.snapshot().filter((sample) => sample.seq > sinceSeq);
  }

  /** Descarta las muestras con t < t_min. Devuelve cuántas se descartaron. */
  discardOldestBefore(tMin: number): number {
    let removed = 0;
    while (this.count > 0 && this.data[this.start * FIELD_COUNT + T] < tMin) {
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
      removed += 1;
    }
    return removed;
  }

  trustedCount(): number {
    let trusted = 0;
    for (let i = 0; i < this.count; i += 1) {
      if (this.data[((this.start + i) % this.capacity) * FIELD_COUNT + TRUSTED] === 1) {
        trusted += 1;
      }
    }
    return trusted;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.dropped = 0;
  }

  get size(): number {
    return this.count;
  }

  get droppedCount(): number {
    return this.dropped;
  }
}
