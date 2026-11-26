// Inferencia de perfil de dispositivo SOLO a partir de datos numéricos ya
// recolectados (nunca strings de eventos, nunca acceso al DOM). Es una función
// pura: el detector la llama con las mismas instantáneas que pasa al scorer.
//
// Reglas (fail-closed):
// - Con mutaciones de texto, es desktop: escribir texto no es un mando.
// - Con muestras de puntero no-mouse (`pointerType !== 0`), es touch. La
//   ausencia de mouse por sí sola NO es evidencia de touch ni de TV.
// - Con movimiento de puntero (kind 0), es desktop.
// - Sin puntero ni texto: solo se infiere tv cuando hay suficientes keydowns
//   y la mayoría son de navegación (4 Enter, 5 flechas, 7 otra/Escape).
// - En cualquier otro caso, desktop.

import type {
  DetailedDevice,
  DeviceProfile,
  InputSample,
  KeySample,
  PointerSample,
} from "../types";

/** Categorías de teclado propias de un mando a distancia (Enter/flechas/Escape). */
const NAVIGATION_CATEGORIES = new Set([4, 5, 7]);

/** Mínimo de keydowns para inferir mando por dominancia de navegación. */
export const TV_MIN_KEY_DOWNS = 8;
/** Share mínimo de keydowns de navegación para inferir tv. */
export const TV_NAV_SHARE = 0.7;

export type ResolvedDeviceProfile = Exclude<DeviceProfile, "auto">;

/**
 * Perfil inferido de las muestras numéricas disponibles. Nunca devuelve
 * `auto`: sin evidencia de mando el perfil es `desktop` (comportamiento
 * previo, sin atajos de scoring).
 */
export function inferDeviceProfile(
  samples: PointerSample[],
  keys: KeySample[],
  inputs: InputSample[],
): ResolvedDeviceProfile {
  // Texto escrito -> desktop, aunque haya muestras táctiles o de mando.
  if (inputs.length > 0) return "desktop";

  let hasPointerMovement = false;
  let hasNonMousePointer = false;
  for (const sample of samples) {
    if (sample.pointerType !== 0) hasNonMousePointer = true;
    if (sample.kind === 0) hasPointerMovement = true;
  }
  // `pointerType !== 0` se reconoce explícitamente; la ausencia de mouse no
  // inventa scoring, solo identifica el perfil cuando hay muestras táctiles.
  if (hasNonMousePointer) return "touch";
  if (hasPointerMovement) return "desktop";

  let downCount = 0;
  let navCount = 0;
  for (const sample of keys) {
    if (sample.kind !== 0) continue;
    downCount += 1;
    if (NAVIGATION_CATEGORIES.has(sample.category)) navCount += 1;
  }
  if (downCount >= TV_MIN_KEY_DOWNS && navCount / downCount >= TV_NAV_SHARE) return "tv";

  return "desktop";
}

// ---------------------------------------------------------------------------
// Perfil detallado (Etapa 9). El perfil grueso de arriba NO se toca: el
// detalle es informativo y se mapea de vuelta al grueso solo para consumidores.
// ---------------------------------------------------------------------------

/** Pantalla pequeña (celular) y mediana (tablet), en píxeles CSS. */
const SMALL_SCREEN_PX = 700;
const MEDIUM_SCREEN_PX = 1300;
/** A partir de aquí se considera computadora de escritorio. */
const LARGE_SCREEN_PX = 1600;

/** Pistas del entorno, capturadas por el detector DENTRO de `start()`. */
export interface DeviceHints {
  /** navigator.maxTouchPoints (0 si no está disponible). */
  maxTouchPoints: number;
  /** user-agent hints: `userAgentData.mobile` o coincidencia de UA móvil. */
  mobile: boolean;
  /** screen.width (0 si no está disponible). */
  screenWidth: number;
}

/** Traducción del perfil detallado al grueso usado por el scoring. */
export const DETAILED_TO_COARSE: Readonly<Record<DetailedDevice, Exclude<DeviceProfile, "auto">>> =
  Object.freeze({
    computadora: "desktop",
    laptop: "desktop",
    celular: "touch",
    tablet: "touch",
    tv: "tv",
    touch: "touch",
  });

function numericHint(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function desktopDetail(width: number): DetailedDevice {
  return width > 0 && width < LARGE_SCREEN_PX ? "laptop" : "computadora";
}

/**
 * Perfil detallado inferido de muestras numéricas y pistas del entorno. Función
 * PURA: nunca lee `window`/`navigator`/`screen`; el detector le pasa las pistas
 * que capturó en `start()`. Sin pistas ni muestras devuelve `computadora`
 * (fail-closed, igual que el perfil grueso).
 */
export function inferDetailedDevice(
  samples: PointerSample[],
  keys: KeySample[],
  inputs: InputSample[],
  hints: Partial<DeviceHints> = {},
): DetailedDevice {
  const safeHints: Partial<DeviceHints> =
    hints !== null && (typeof hints === "object" || typeof hints === "function") ? hints : {};
  const maxTouchPoints = numericHint(safeHints.maxTouchPoints);
  const mobile = safeHints.mobile === true;
  const width = numericHint(safeHints.screenWidth);
  const safeInputs = Array.isArray(inputs) ? inputs : [];

  let hasPointerMovement = false;
  let hasNonMousePointer = false;
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (sample.pointerType !== 0) hasNonMousePointer = true;
    if (sample.kind === 0) hasPointerMovement = true;
  }

  // Puntero táctil: la pista de pantalla/UA distingue celular de tablet; sin
  // pistas se queda en `touch` (no inventamos más detalle).
  if (hasNonMousePointer) {
    if (mobile || (width > 0 && width <= SMALL_SCREEN_PX)) return "celular";
    if (maxTouchPoints > 0 || (width > 0 && width <= MEDIUM_SCREEN_PX)) return "tablet";
    return "touch";
  }
  // Texto escrito o mouse: perfil de escritorio; el ancho sugiere laptop.
  if (safeInputs.length > 0 || hasPointerMovement) return desktopDetail(width);

  // Mando a distancia: mismas reglas que el perfil grueso.
  let downCount = 0;
  let navCount = 0;
  for (const sample of Array.isArray(keys) ? keys : []) {
    if (sample.kind !== 0) continue;
    downCount += 1;
    if (NAVIGATION_CATEGORIES.has(sample.category)) navCount += 1;
  }
  if (downCount >= TV_MIN_KEY_DOWNS && navCount / downCount >= TV_NAV_SHARE) return "tv";

  // Solo pistas del entorno (aún no hay muestras o no son concluyentes).
  if (mobile) return "celular";
  if (maxTouchPoints > 0) {
    if (width > 0 && width <= SMALL_SCREEN_PX) return "celular";
    if (width > 0 && width <= MEDIUM_SCREEN_PX) return "tablet";
    return "touch";
  }
  if (width > 0) return desktopDetail(width);
  return "computadora";
}
