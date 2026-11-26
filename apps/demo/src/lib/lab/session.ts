// Sesiones en memoria: forma, exportación e importación defensiva de JSON.
// Sin localStorage, cookies ni red; el archivo se lee con File.text() local.

import type {
  ClickSample,
  InputSample,
  KeySample,
  PointerSample,
  ScrollSample,
} from "is-that-an-ai";
import { tr } from "#lib/i18n";

export interface StatsSnapshot {
  sampleCount: number;
  droppedCount: number;
  eventsPerSecond: number;
  bufferFill: number;
  trustedRatio: number;
  lastEventAt: number;
  clickCount: number;
  scrollCount: number;
  keyCount: number;
  inputCount: number;
}

export interface SessionSnapshot {
  points: PointerSample[];
  clicks: ClickSample[];
  scrolls: ScrollSample[];
  keys: KeySample[];
  inputs: InputSample[];
}

export interface SessionRecord {
  version: 1;
  recordedAt: string;
  durationMs: number;
  source: "grabada" | "importada";
  samples: SessionSnapshot;
}

export interface SessionSummary {
  points: number;
  clicks: number;
  scrolls: number;
  keys: number;
  inputs: number;
  total: number;
  durationMs: number;
}

const MAX_ITEMS = 200_000;

export function emptySnapshot(): SessionSnapshot {
  return { points: [], clicks: [], scrolls: [], keys: [], inputs: [] };
}

export function createSession(
  samples: SessionSnapshot,
  durationMs: number,
  source: "grabada" | "importada" = "grabada",
): SessionRecord {
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    source,
    samples: {
      points: [...samples.points],
      clicks: [...samples.clicks],
      scrolls: [...samples.scrolls],
      keys: [...samples.keys],
      inputs: [...samples.inputs],
    },
  };
}

export function summarize(record: SessionRecord): SessionSummary {
  const { points, clicks, scrolls, keys, inputs } = record.samples;
  return {
    points: points.length,
    clicks: clicks.length,
    scrolls: scrolls.length,
    keys: keys.length,
    inputs: inputs.length,
    total: points.length + clicks.length + scrolls.length + keys.length + inputs.length,
    durationMs: record.durationMs,
  };
}

export function serializeSession(record: SessionRecord): string {
  return JSON.stringify(record, null, 2);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCode(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isPointer(value: unknown): value is PointerSample {
  return (
    isObject(value) &&
    isNumber(value.seq) &&
    isNumber(value.x) &&
    isNumber(value.y) &&
    isNumber(value.t) &&
    isCode(value.kind, 0, 2) &&
    isCode(value.pointerType, 0, 3) &&
    isCode(value.trusted, 0, 1)
  );
}

function isClick(value: unknown): value is ClickSample {
  return (
    isObject(value) &&
    isNumber(value.seq) &&
    isNumber(value.x) &&
    isNumber(value.y) &&
    isNumber(value.t) &&
    isCode(value.kind, 0, 1) &&
    isNumber(value.button) &&
    isCode(value.trusted, 0, 1)
  );
}

function isScroll(value: unknown): value is ScrollSample {
  return (
    isObject(value) &&
    isNumber(value.seq) &&
    isNumber(value.dx) &&
    isNumber(value.dy) &&
    isNumber(value.t) &&
    isCode(value.trusted, 0, 1) &&
    isCode(value.source, 0, 1)
  );
}

function isKey(value: unknown): value is KeySample {
  return (
    isObject(value) &&
    isNumber(value.seq) &&
    isNumber(value.t) &&
    isCode(value.kind, 0, 1) &&
    isCode(value.category, 0, 7) &&
    isCode(value.trusted, 0, 1)
  );
}

function isInput(value: unknown): value is InputSample {
  return (
    isObject(value) &&
    isNumber(value.seq) &&
    isNumber(value.t) &&
    value.kind === 0 &&
    isCode(value.inputType, 0, 5) &&
    isCode(value.trusted, 0, 1)
  );
}

function readArray<T>(
  root: Record<string, unknown>,
  key: string,
  valid: (v: unknown) => boolean,
): T[] {
  const value = root[key];
  if (!Array.isArray(value)) throw new Error(tr("session.error.list", { key }));
  if (value.length > MAX_ITEMS) throw new Error(tr("session.error.tooMany", { key }));
  for (const item of value) {
    if (!valid(item)) throw new Error(tr("session.error.invalidSample", { key }));
  }
  return value as T[];
}

/** Parsea un archivo exportado por esta demo; nunca confía en su forma. */
export function parseSession(text: string): SessionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(tr("session.error.invalidJson"));
  }
  if (!isObject(raw)) throw new Error(tr("session.error.notObject"));
  if (raw.version !== 1) throw new Error(tr("session.error.version"));
  if (typeof raw.recordedAt !== "string") throw new Error(tr("session.error.date"));
  if (!isNumber(raw.durationMs) || raw.durationMs < 0) {
    throw new Error(tr("session.error.duration"));
  }
  if (!isObject(raw.samples)) throw new Error(tr("session.error.samples"));
  const samples = raw.samples;
  return {
    version: 1,
    recordedAt: raw.recordedAt,
    durationMs: raw.durationMs,
    source: "importada",
    samples: {
      points: readArray<PointerSample>(samples, "points", isPointer),
      clicks: readArray<ClickSample>(samples, "clicks", isClick),
      scrolls: readArray<ScrollSample>(samples, "scrolls", isScroll),
      keys: readArray<KeySample>(samples, "keys", isKey),
      inputs: readArray<InputSample>(samples, "inputs", isInput),
    },
  };
}
