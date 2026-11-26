// Generador del laboratorio honesto (Etapa 8). Script independiente, sin
// dependencias nuevas: importa los MISMOS perfiles y la MISMA evaluación que
// tests/lab-report.test.ts y vuelca la tabla medida a LAB_REPORT.md (raíz).
//
// Sin red, sin storage, sin DOM al importar. Los datos son solo números.

import { evaluateAll, type LabRow } from "../packages/is-that-an-ai/tests/lab-profiles";

const DATE = "2026-11-26";
const fmt = (value: number | null): string => (value === null ? "—" : value.toFixed(4));
const yesNo = (value: boolean): string => (value ? "sí" : "no");

function truthLabel(row: LabRow): string {
  return row.truth === "human" ? "humano" : "agente";
}

type Align = "left" | "right";

/**
 * Tabla markdown ya formateada como la espera Biome: cada celda se acolcha a
 * el ancho máximo de su columna y las columnas numéricas (`---:`) se alinean
 * a la derecha. Así el reporte generado no necesita retoques a mano.
 */
function markdownTable(headers: string[], aligns: Align[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells
      .map((cell, i) => (aligns[i] === "right" ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join(" | ")} |`;
  const rule = widths.map((width, i) =>
    aligns[i] === "right" ? `${"-".repeat(width - 1)}:` : "-".repeat(width),
  );
  return [line(headers), line(rule), ...rows.map(line)].join("\n");
}

function mainTable(rows: LabRow[]): string {
  return markdownTable(
    ["Perfil", "Señal", "Score", "Veredicto", "¿Detectado?", "Esperado", "Limitaciones"],
    ["left", "left", "right", "left", "left", "left", "left"],
    rows.map((row) => [
      row.profile,
      row.signal,
      fmt(row.score),
      row.band,
      yesNo(row.detected),
      truthLabel(row),
      row.note,
    ]),
  );
}

function signalTable(rows: LabRow[]): string {
  return markdownTable(
    ["Perfil", "mouse", "click", "scroll", "keyboard"],
    ["left", "right", "right", "right", "right"],
    rows.map((row) => [
      row.id,
      fmt(row.mouseScore),
      fmt(row.clickScore),
      fmt(row.scrollScore),
      fmt(row.keyboardScore),
    ]),
  );
}

function buildReport(rows: LabRow[]): string {
  const undetectedAgents = rows.filter((row) => row.truth === "agent" && !row.detected);
  const replay = rows.find((row) => row.id === "human-keyboard-replay");
  const naive = rows.find((row) => row.id === "naive-bot-combined");
  const naiveKeyboard = rows.find((row) => row.id === "naive-bot-keyboard");

  return `# Laboratorio honesto — Etapa 8

> **SIMULATED PROFILES, NOT REAL-AGENT SESSIONS.**
> Perfiles **simulados**, no sesiones de agentes reales. La única fila
> \`REAL-DERIVED\` es un volcado **numérico** de una sesión humana de teclado
> grabada el 2026-11-26; no es una traza de agente. Nadie ejecutó a Grok Bot ni
> a otro agente para producir estas filas. Los veredictos son probabilísticos:
> esta tabla mide **qué detecta hoy la librería**, no cuánto dura en la vida real.

- Fecha: ${DATE}
- Comandos: \`bun test packages/is-that-an-ai/tests/lab-report.test.ts\` y \`bun tools/lab-report.ts\`
- Código: \`packages/is-that-an-ai/tests/lab-profiles.ts\` (perfiles) y
  \`tests/lab-report.test.ts\` (mismas bandas, verificadas).

## Resultados medidos

${mainTable(rows)}

\`¿Detectado?\` = el veredicto fue **agente** (score ≥ 0.55). \`Esperado\` es la
etiqueta de origen del perfil, no un deseo: cuando \`Esperado = agente\` y
\`¿Detectado? = no\`, hay un **falso negativo** y se dice aquí.

### Desglose por señal (score 0 = humano, 1 = agente; «—» = sin evidencia)

${signalTable(rows)}

## Metodología

1. **Perfiles deterministas.** Generadores con LCG de semilla fija (sin
   \`Math.random\`, sin dependencias). Ningún dato contiene teclas, texto,
   red, storage ni DOM; solo \`t\`, duraciones, magnitudes y categorías 0..7.
   Toda fila se etiqueta \`SIMULATED\` o \`REAL-DERIVED\` en su propio nombre.
2. **Fuentes.** ratón/clic/scroll humanos y de bots: generadores imitando los
   perfiles ya calibrados en \`tests/fleet-calibration.test.ts\` y
   \`tests/e2e-retune.test.ts\`. Teclado humano \`REAL-DERIVED\`: la sesión
   grabada \`calibracion-teclado(1).json\` (mediana IKI 189ms, hold 94ms,
   pausas de 1000/6813ms), volcada solo como \`[t, kind, category]\`.
   Teclado de agente naive: IKI fijo 7ms y hold 10ms, en la banda de las
   referencias públicas (Browser Use 5.31ms, Skyvern 9.52ms, Manus 1.39ms,
   FP-Agent arXiv:2605.01247). El humano de referencia CMU tiene IKI p50 191ms.
3. **Evaluación.** Un \`ScoreComputer\` **nuevo por fila** (sin EMA arrastrado):
   \`evaluate(mouse, windowMs, clicks, scrolls, keys, inputs)\`. Se exige
   evidencia mínima por señal (10 movimientos, 10 clics, 8 scrolls, o las vías
   de teclado calibradas). Bandas: \`≤ 0.25\` (HUMAN_MAX) → humano,
   \`≥ 0.55\` (AI_MIN) → agente; entre medias, **duda** (no cuenta como éxito).
   El test además confirma el bot naive con \`IsThatAnAI\` usando un reloj
   \`now\` inyectado y eventos sintéticos ordenados por \`timeStamp\`.
4. **Repetibilidad.** Los mismos perfiles alimentan el test y este script a
   través de \`evaluateProfile()\`; las cifras de arriba son las que imprimen
   ambos, no valores reescritos a mano.

## Honestidad: lo que NO se detecta

- **Agente humanizado (${undetectedAgents.length} filas): NO detectado.** Añadir
  jitter y pausas de ciclo corto rompe \`exactRhythm\` e
  \`intervalRegularity\`; las filas \`humanized-agent-*\` quedan en banda
  \`human\` con scores ${undetectedAgents.map((row) => fmt(row.score)).join(" y ")}.
  Se contabiliza como falso negativo en la columna \`Esperado\`. Un agente con
  acceso al código puede disfrazarse mejor todavía.
- **Replay idéntico: NO marcado como replay.** La sesión humana real repetida
  dos veces (\`${replay?.id ?? "human-keyboard-replay"}\`, score
  ${fmt(replay?.score ?? null)}) se clasifica como humana: la librería actual
  no compara entre sesiones. Es una limitación conocida (Etapa 10), no un
  resultado positivo.
- **Mouse del bot naive, insuficiente por sí solo:** ${fmt(naive?.mouseScore ?? null)}
  (banda de duda). La detección global del bot naive (${fmt(naive?.score ?? null)})
  viene de clics+scroll y roza AI_MIN: un cambio de jitter podría hacerla caer
  en duda.
- **Bot naive de teclado:** ${fmt(naiveKeyboard?.score ?? null)} se detecta
  porque su cadencia es perfectamente regular. Eso es una traza sintética, no
  la medición de un agente real ejecutándose aquí.
- **Muestra pequeña:** un solo sujeto humano real, y ratón/clic/scroll humano
  son simulaciones. No hay medición de falsos positivos sobre población, ni de
  dispositivos móviles/tablets, ni de accesibilidad.
- **Veredictos, no verdad:** el código corre en el navegador; un bot que lo
  parchea o que genera eventos confiables de verdad puede evadirlo. Sin
  servidor no se puede comparar una grabación entre sesiones.

## Reglas respetadas

Cero red, cero almacenamiento persistente, cero cookies/fingerprinting, nunca
se guarda qué tecla se pulsó (solo tiempos y categorías numéricas). Importar
estos módulos no toca \`window\`, \`document\` ni \`navigator\`.
`;
}

const rows = evaluateAll();
const markdown = buildReport(rows);
const output = new URL("../LAB_REPORT.md", import.meta.url);
await Bun.write(output, markdown);
console.log(`LAB_REPORT.md escrito: ${output.pathname}`);
console.log(`\n${markdown}`);
