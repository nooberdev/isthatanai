// Buffer circular genérico de números. Almacena solo Float64Array: no se
// asigna ningún objeto por evento; las filas tipadas se crean solo al leer.

export class NumericRingBuffer {
  readonly capacity: number;
  /** Número de columnas por muestra. */
  readonly fields: number;
  private readonly data: Float64Array;
  private start = 0;
  private count = 0;
  private dropped = 0;

  constructor(capacity: number, fields: number) {
    const c = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
    const f = Number.isFinite(fields) && fields > 0 ? Math.floor(fields) : 1;
    this.capacity = c;
    this.fields = f;
    this.data = new Float64Array(c * f);
  }

  /**
   * Escribe una fila de hasta 7 columnas. Firma fija (sin `...args`, sin
   * literales de array): no hay asignaciones por evento.
   */
  push(a: number, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0): void {
    const index = (this.start + this.count) % this.capacity;
    const base = index * this.fields;
    this.data[base] = a;
    if (this.fields > 1) this.data[base + 1] = b;
    if (this.fields > 2) this.data[base + 2] = c;
    if (this.fields > 3) this.data[base + 3] = d;
    if (this.fields > 4) this.data[base + 4] = e;
    if (this.fields > 5) this.data[base + 5] = f;
    if (this.fields > 6) this.data[base + 6] = g;

    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.dropped += 1;
    } else {
      this.count += 1;
    }
  }

  /** Copia ordenada de la muestra más antigua a la más reciente. */
  rows(): Float64Array[] {
    const result: Float64Array[] = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const base = ((this.start + i) % this.capacity) * this.fields;
      result[i] = this.data.slice(base, base + this.fields);
    }
    return result;
  }

  /** Descarta filas con t < tMin en la columna `tField`. Devuelve cuántas. */
  discardOldestBefore(tMin: number, tField: number): number {
    let removed = 0;
    while (this.count > 0 && this.data[this.start * this.fields + tField] < tMin) {
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
      removed += 1;
    }
    return removed;
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
