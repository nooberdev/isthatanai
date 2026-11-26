/**
 * Estado visual del veredicto. Inicialmente solo existe el estado "midiendo";
 * en una etapa posterior el detector real definirá qué lleva cada estado.
 * Aquí el objetivo (`setTarget`) es lo que suele producirse (clicks, escritura...).
 */
export type VerdictState = "midiendo" | "humano" | "ia";

/**
 * Tiempo que el objetivo debe mantenerse estable antes de cambiar el estado visual.
 * Sirve a la regla de anti-parpadeo de la etapa de movimiento.
 */
const ANTI_FLICKER_MS = 800;

export function createVerdict() {
  let target = $state<VerdictState>("midiendo");
  let committed = $state<VerdictState>("midiendo");
  let commitTimer: ReturnType<typeof setTimeout> | undefined;

  function setTarget(v: VerdictState): void {
    target = v;
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      committed = v;
    }, ANTI_FLICKER_MS);
  }

  // Test hook: confirma inmediatamente (usado por ?estado=... en capturas;
  // el camino de interacción normal sigue pasando por setTarget).
  function forceCommit(v: VerdictState): void {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    committed = v;
  }

  return {
    get target(): VerdictState {
      return target;
    },
    get committed(): VerdictState {
      return committed;
    },
    setTarget,
    forceCommit,
  };
}
