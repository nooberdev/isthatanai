import { describe, expect, it } from "bun:test";
import { RingBuffer } from "../src/utils/ring-buffer";

function fill(buffer: RingBuffer, count: number, startSeq = 1): void {
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    buffer.push(seq, seq + 0.25, seq * 2, seq * 10, 0, 0, seq % 2);
  }
}

describe("RingBuffer", () => {
  it("respeta la capacidad, cuenta descartes y conserva el orden al envolver", () => {
    const buffer = new RingBuffer(3);
    fill(buffer, 5);

    expect(buffer.size).toBe(3);
    expect(buffer.capacity).toBe(3);
    expect(buffer.droppedCount).toBe(2);
    expect(buffer.snapshot().map((sample) => sample.seq)).toEqual([3, 4, 5]);
    expect(buffer.snapshot().map((sample) => sample.x)).toEqual([3.25, 4.25, 5.25]);
  });

  it("descarta las muestras más antiguas antes de t y mantiene seq creciente", () => {
    const buffer = new RingBuffer(5);
    fill(buffer, 4);

    expect(buffer.discardOldestBefore(21)).toBe(2);
    expect(buffer.snapshot().map((sample) => sample.seq)).toEqual([3, 4]);

    buffer.push(5, 5.25, 10, 50, 0, 0, 1);
    const samples = buffer.snapshot();
    expect(samples.map((sample) => sample.seq)).toEqual([3, 4, 5]);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i].seq).toBeGreaterThan(samples[i - 1].seq);
    }
  });

  it("filtra por seq y expone el conteo de confiables", () => {
    const buffer = new RingBuffer(4);
    fill(buffer, 4);

    expect(buffer.snapshotSince(2).map((sample) => sample.seq)).toEqual([3, 4]);
    expect(buffer.trustedCount()).toBe(2);

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.droppedCount).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });
});
