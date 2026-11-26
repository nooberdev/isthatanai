// Medidas táctiles puras: funciones sobre TouchSample[]. SIN DOM, SIN red,
// SIN almacenamiento, SIN identidad de puntero (no se guarda pointerId).
// Cada medida en [0,1], 1 = mas probable IA. Entrada insuficiente -> 0
// (documentado: al estar los pesos a 0, el neutro es literalmente 0).
//
// Umbrales documentados (lineales entre los extremos):
// 1. pressure        - CV de presiones > 0: <=0.05 -> 1, >=0.30 -> 0.
// 2. contactArea     - CV de radiusX*radiusY: <=0.05 -> 1, >=0.40 -> 0.
// 3. tilt            - desv./360 de rotationAngle: <=0.002 -> 1, >=0.020 -> 0.
// 4. duration        - CV de duraciones down->up: <=0.05 -> 1, >=0.40 -> 0.
// 5. inertialSlide   - razon velocidad final/inicial: >=0.98 -> 1, <=0.60 -> 0
//                      (velocidad constante = sin deslizamiento inercial).
// 6. multiTouch      - proporcion de gestos con salto posicional brusco (proxy de
//                      multidedo sin pointerId): 0 -> 1, >=0.30 -> 0.
// 7. pinchZoom       - proporcion de gestos con expansion/contraccion >=2x de
//                      la separacion inicial: 0 -> 1, >=0.30 -> 0.
// 8. touchVsClick    - ratio de toques falsos (duracion <=1ms y sin recorrido):
//                      <=0.05 -> 0, >=0.50 -> 1.
// 9. deviceMotion    - sinus fragil de micro-jitter durante una pulsacion casi
//                      estatica: 0 -> 1, >=0.30 -> 0. NO usa DeviceMotion API:
//                      se infiere SOLO de la trayectoria numerica (sin
//                      acelerometro, sin permiso, sin sensores). Es un proxy,
//                      no una lectura real del movimiento del dispositivo.
// 10. handTremor     - desv. perpendicular / longitud de paso: <=0.01 -> 1,
//                      >=0.08 -> 0 (trayectoria perfectamente limpia = IA).
//
// RENDIMIENTO: `extractTouchFeatures` prepara los gestos una sola vez y los
// reutiliza en las 10 medidas. Las funciones publicas siguen siendo
// independientes y producen exactamente los mismos valores.

import type { TouchSample } from "../collectors/touch";
import { clamp, distance, linear, mean, stddev } from "../utils/math";

/** Diez medidas numericas; ninguna entra en el score actual (pesos 0). */
export interface TouchFeatures {
  pressure: number;
  contactArea: number;
  tilt: number;
  duration: number;
  inertialSlide: number;
  multiTouch: number;
  pinchZoom: number;
  touchVsClick: number;
  deviceMotion: number;
  handTremor: number;
}

/** Tabla congelada: todos 0 para no alterar la calibracion existente. */
export const TOUCH_FEATURE_WEIGHTS = Object.freeze({
  pressure: 0,
  contactArea: 0,
  tilt: 0,
  duration: 0,
  inertialSlide: 0,
  multiTouch: 0,
  pinchZoom: 0,
  touchVsClick: 0,
  deviceMotion: 0,
  handTremor: 0,
} as const satisfies Readonly<Record<keyof TouchFeatures, number>>);

// Cotas defensivas: NaN/±Infinity/1e308 no pueden desbordar restas ni CV.
const MAX_COORD = 1e9;
const MAX_TIME = 1e15;
const MAX_RADIUS = 1e6;

function bounded(value: number, limit: number): number {
  return Number.isFinite(value) ? clamp(value, -limit, limit) : 0;
}

function sanitize(sample: TouchSample): TouchSample {
  return {
    ...sample,
    t: Math.max(0, bounded(sample.t, MAX_TIME)),
    kind: sample.kind === 1 ? 1 : 0,
    x: bounded(sample.x, MAX_COORD),
    y: bounded(sample.y, MAX_COORD),
    pointerType: Number.isFinite(sample.pointerType) ? clamp(sample.pointerType, 0, 3) : 0,
    pressure: Number.isFinite(sample.pressure) ? clamp(sample.pressure, 0, 1) : 0,
    radiusX: Number.isFinite(sample.radiusX) ? clamp(sample.radiusX, 0, MAX_RADIUS) : 0,
    radiusY: Number.isFinite(sample.radiusY) ? clamp(sample.radiusY, 0, MAX_RADIUS) : 0,
    rotationAngle: Number.isFinite(sample.rotationAngle) ? clamp(sample.rotationAngle, 0, 360) : 0,
    trusted: sample.trusted === 1 ? 1 : 0,
  };
}

function unit(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/** Coeficiente de variacion: 0 si hay menos de 2 valores o la media es ~0. */
function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return m <= 1e-9 ? 0 : stddev(values) / m;
}

/** Gesto = run de contactos (kind 0) cerrado por una muestra kind 1. */
interface Gesture {
  samples: TouchSample[];
  end: TouchSample | null;
}

function gesturesOf(raw: TouchSample[]): Gesture[] {
  const gestures: Gesture[] = [];
  let current: TouchSample[] = [];
  for (const sample of raw) {
    if (sample.kind === 0) {
      current.push(sample);
    } else {
      if (current.length > 0) gestures.push({ samples: current, end: sample });
      current = [];
    }
  }
  if (current.length > 0) gestures.push({ samples: current, end: null });
  return gestures;
}

function prepare(samples: TouchSample[]): Gesture[] {
  return gesturesOf(samples.map(sanitize));
}

/** Presion constante (o ausente) del dedo: CV <=0.05 -> 1, >=0.30 -> 0. */
function pressureOf(gestures: Gesture[]): number {
  const pressures: number[] = [];
  for (const gesture of gestures) {
    for (const sample of gesture.samples) if (sample.pressure > 0) pressures.push(sample.pressure);
  }
  if (pressures.length < 2) return 0;
  return unit(1 - linear(cv(pressures), 0.05, 0.3));
}

/** Area de contacto constante: CV(radiusX*radiusY) <=0.05 -> 1, >=0.40 -> 0. */
function contactAreaOf(gestures: Gesture[]): number {
  const areas: number[] = [];
  for (const gesture of gestures) {
    for (const sample of gesture.samples) {
      const area = sample.radiusX * sample.radiusY;
      if (area > 0) areas.push(area);
    }
  }
  if (areas.length < 2) return 0;
  return unit(1 - linear(cv(areas), 0.05, 0.4));
}

/**
 * Inclinacion proxy = rotationAngle (grados). desv./360 <=0.002 -> 1.
 *
 * 0 es el valor por defecto que informan los navegadores cuando el dispositivo
 * no expone rotationAngle: no es "inclinacion constante" (que seria IA), sino
 * dato ausente. Se descarta como en pressure/contactArea; sin al menos dos
 * angulos reales la medida es neutra (0).
 */
function tiltOf(gestures: Gesture[]): number {
  const angles: number[] = [];
  for (const gesture of gestures) {
    for (const sample of gesture.samples) {
      if (sample.rotationAngle > 0) angles.push(sample.rotationAngle);
    }
  }
  if (angles.length < 2) return 0;
  return unit(1 - linear(stddev(angles) / 360, 0.002, 0.02));
}

/** Duraciones down->up demasiado regulares: CV <=0.05 -> 1, >=0.40 -> 0. */
function durationOf(gestures: Gesture[]): number {
  const durations: number[] = [];
  for (const gesture of gestures) {
    if (gesture.end && gesture.samples.length > 0) {
      durations.push(Math.max(0, gesture.end.t - gesture.samples[0].t));
    }
  }
  if (durations.length < 2) return 0;
  return unit(1 - linear(cv(durations), 0.05, 0.4));
}

/**
 * Deslizamiento inercial: razon entre la velocidad media de los ultimos dos
 * pasos y la de los dos primeros. Un dedo humano decelera al soltar; un agente
 * mantiene una velocidad constante hasta cortar en seco.
 * ratio >=0.98 -> 1; <=0.60 -> 0. Media ponderada por pasos entre gestos.
 */
function inertialSlideOf(gestures: Gesture[]): number {
  let acc = 0;
  let total = 0;
  for (const gesture of gestures) {
    const points = gesture.samples;
    if (points.length < 4) continue;
    const speeds: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const dt = points[i].t - points[i - 1].t;
      if (dt <= 0) continue;
      speeds.push(distance(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) / dt);
    }
    if (speeds.length < 3) continue;
    const first = (speeds[0] + speeds[1]) / 2;
    const last = (speeds[speeds.length - 1] + speeds[speeds.length - 2]) / 2;
    if (first <= 1e-9) continue;
    acc += linear(last / first, 0.6, 0.98) * speeds.length;
    total += speeds.length;
  }
  return total > 0 ? unit(acc / total) : 0;
}

/**
 * Multidedo proxy: sin pointerId (no se guarda por privacidad), dos dedos
 * concurrentes solo se infieren de un salto posicional brusco entre
 * contactos (<=50ms y >=80px). ratio 0 -> 1 (bot de un dedo), >=0.30 -> 0.
 */
function multiTouchOf(gestures: Gesture[]): number {
  let flagged = 0;
  let total = 0;
  for (const gesture of gestures) {
    const points = gesture.samples;
    if (points.length < 2) continue;
    total += 1;
    let found = false;
    for (let i = 1; i < points.length; i += 1) {
      const dt = points[i].t - points[i - 1].t;
      const d = distance(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      if (dt >= 0 && dt <= 50 && d >= 80) {
        found = true;
        break;
      }
    }
    if (found) flagged += 1;
  }
  return total > 0 ? unit(1 - linear(flagged / total, 0, 0.3)) : 0;
}

/**
 * Pellizco/zoom proxy: separacion entre los dos ultimos contactos frente a la
 * de los dos primeros. Expansion/contraccion >=2x => gesto de pinza.
 * proporcion 0 -> 1 (bot que nunca pellizca), >=0.30 -> 0.
 */
function pinchZoomOf(gestures: Gesture[]): number {
  let flagged = 0;
  let total = 0;
  for (const gesture of gestures) {
    const points = gesture.samples;
    if (points.length < 4) continue;
    total += 1;
    const first = distance(points[1].x - points[0].x, points[1].y - points[0].y);
    const n = points.length;
    const last = distance(points[n - 1].x - points[n - 2].x, points[n - 1].y - points[n - 2].y);
    const ratio = last / (first + 1e-9);
    if (ratio >= 2 || ratio <= 0.5) flagged += 1;
  }
  return total > 0 ? unit(1 - linear(flagged / total, 0, 0.3)) : 0;
}

/** Toque falso: duracion <=1ms y recorrido ~0 (click de mouse simulado). */
function touchVsClickOf(gestures: Gesture[]): number {
  let fakes = 0;
  let total = 0;
  for (const gesture of gestures) {
    if (!gesture.end || gesture.samples.length === 0) continue;
    total += 1;
    let path = 0;
    for (let i = 1; i < gesture.samples.length; i += 1) {
      path += distance(
        gesture.samples[i].x - gesture.samples[i - 1].x,
        gesture.samples[i].y - gesture.samples[i - 1].y,
      );
    }
    const duration = Math.max(0, gesture.end.t - gesture.samples[0].t);
    if (duration <= 1 && path <= 1e-9) fakes += 1;
  }
  return total > 0 ? unit(linear(fakes / total, 0.05, 0.5)) : 0;
}

/**
 * Movimiento del dispositivo SOLO por trayectoria numerica: micro-jitter con
 * inversciones de sentido durante una pulsacion casi estatica (recorrido <=3px).
 * Sin acelerometro/DeviceMotion API ni permisos: es un PROXY, no una lectura
 * real del sensor. proporcion 0 -> 1 (bot perfectamente inmovil), >=0.30 -> 0.
 */
function deviceMotionOf(gestures: Gesture[]): number {
  let flagged = 0;
  let total = 0;
  for (const gesture of gestures) {
    const points = gesture.samples;
    if (points.length < 3) continue;
    total += 1;
    let path = 0;
    let reversals = 0;
    let previous = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      path += distance(dx, points[i].y - points[i - 1].y);
      const sign = dx > 0.05 ? 1 : dx < -0.05 ? -1 : 0;
      if (sign !== 0) {
        if (previous !== 0 && sign !== previous) reversals += 1;
        previous = sign;
      }
    }
    if (path <= 3 && reversals >= 2) flagged += 1;
  }
  return total > 0 ? unit(1 - linear(flagged / total, 0, 0.3)) : 0;
}

/**
 * Temblor de la mano: desviacion perpendicular media al segmento que une a los
 * dos vecinos, normalizada por el paso medio. <=0.01 -> 1, >=0.08 -> 0.
 */
function handTremorOf(gestures: Gesture[]): number {
  let acc = 0;
  let total = 0;
  for (const gesture of gestures) {
    const points = gesture.samples;
    if (points.length < 3) continue;
    let path = 0;
    for (let i = 1; i < points.length; i += 1) {
      path += distance(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    if (path <= 1e-9) continue;
    const stepLen = path / (points.length - 1);
    let deviation = 0;
    let count = 0;
    for (let i = 1; i < points.length - 1; i += 1) {
      const dx = points[i + 1].x - points[i - 1].x;
      const dy = points[i + 1].y - points[i - 1].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const px = points[i].x - points[i - 1].x;
      const py = points[i].y - points[i - 1].y;
      const perp =
        len <= 1e-9 ? distance(px, py) : Math.abs(px * dy - py * dx) / Math.max(1e-9, len);
      deviation += perp;
      count += 1;
    }
    if (count === 0) continue;
    acc += (1 - linear(deviation / count / stepLen, 0.01, 0.08)) * count;
    total += count;
  }
  return total > 0 ? unit(acc / total) : 0;
}

export function touchPressure(samples: TouchSample[]): number {
  return pressureOf(prepare(samples));
}

export function touchContactArea(samples: TouchSample[]): number {
  return contactAreaOf(prepare(samples));
}

export function touchTilt(samples: TouchSample[]): number {
  return tiltOf(prepare(samples));
}

export function touchDuration(samples: TouchSample[]): number {
  return durationOf(prepare(samples));
}

export function touchInertialSlide(samples: TouchSample[]): number {
  return inertialSlideOf(prepare(samples));
}

export function touchMultiTouch(samples: TouchSample[]): number {
  return multiTouchOf(prepare(samples));
}

export function touchPinchZoom(samples: TouchSample[]): number {
  return pinchZoomOf(prepare(samples));
}

export function touchVsClickFalse(samples: TouchSample[]): number {
  return touchVsClickOf(prepare(samples));
}

export function touchDeviceMotion(samples: TouchSample[]): number {
  return deviceMotionOf(prepare(samples));
}

export function touchHandTremor(samples: TouchSample[]): number {
  return handTremorOf(prepare(samples));
}

/** Extrae las 10 medidas en una sola preparacion de gestos. */
export function extractTouchFeatures(samples: TouchSample[]): TouchFeatures {
  const gestures = prepare(samples);
  return {
    pressure: pressureOf(gestures),
    contactArea: contactAreaOf(gestures),
    tilt: tiltOf(gestures),
    duration: durationOf(gestures),
    inertialSlide: inertialSlideOf(gestures),
    multiTouch: multiTouchOf(gestures),
    pinchZoom: pinchZoomOf(gestures),
    touchVsClick: touchVsClickOf(gestures),
    deviceMotion: deviceMotionOf(gestures),
    handTremor: handTremorOf(gestures),
  };
}
