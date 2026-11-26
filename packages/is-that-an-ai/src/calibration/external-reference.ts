// Referencias públicas externas para la calibración. Solo estadísticas
// derivadas + cita: NO se distribuyen logs crudos ni textos de los sujetos.

/** Cuantiles en ms de una distribución de referencia. */
export interface ReferenceQuantiles {
  p10: number;
  p50: number;
  p90: number;
}

/**
 * CMU DSL Strong Password Benchmark: 51 sujetos, 20.400 repeticiones.
 * Descargado de https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv
 * y agregado aquí (224.400 holds y 204.000 intervalos down-down).
 * Licencia: datos de libre uso; cortesía avisar si se publican resultados.
 * Es texto corto de contraseña: NO contiene pausas naturales largas.
 */
export const CMU_KEYBOARD_REFERENCE: {
  source: string;
  url: string;
  license: string;
  sessions: number;
  holdMs: ReferenceQuantiles;
  keyIntervalMs: ReferenceQuantiles;
} = {
  source: "CMU DSL Strong Password Benchmark",
  url: "https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv",
  license: "Libre uso con cortesía de aviso si se publican resultados",
  sessions: 20400,
  holdMs: { p10: 55.7, p50: 86.1, p90: 128.6 },
  keyIntervalMs: { p10: 94.5, p50: 191.1, p90: 462.3 },
};

/**
 * FP-Agent (arXiv:2605.01247, §5.3): agentes de IA reales sobre un sitio
 * instrumentado. Mediciones publicadas, no descargables con licencia clara:
 * citar, no redistribuir las trazas.
 */
export const AGENT_KEYBOARD_REFERENCE: {
  source: string;
  url: string;
  license: string;
  interKeyMs: Record<string, number>;
  holdMs: Record<string, number>;
} = {
  source: "FP-Agent (arXiv:2605.01247)",
  url: "https://arxiv.org/html/2605.01247",
  license: "Sin licencia explícita: citar, no redistribuir trazas",
  interKeyMs: { "Browser Use": 5.31, Skyvern: 9.52, Manus: 1.39 },
  holdMs: { "Browser Use": 10.19, Skyvern: 11.33, Manus: 52.92 },
};

/**
 * Otras fuentes útiles localizadas, con licencia verificada, para ampliar
 * el perfil cuando se necesiten ratón/scroll o muestras humanas adversarias.
 */
export const FURTHER_REFERENCES = [
  {
    source: "Zenodo KeyRecs (100 usuarios, tecleo fijo y libre)",
    url: "https://zenodo.org/records/7886743",
    license: "CC BY 4.0",
    use: "Distribuciones DU/DD en segundos, 5.7 MB",
  },
  {
    source: "Mendeley González & Calot (humanos vs 5 sintetizadores, español)",
    url: "https://data.mendeley.com/datasets/mzm86rcxxd/2",
    license: "CC BY-NC 3.0",
    use: "HT/FT por tecla; pares humano vs bot estadístico",
  },
  {
    source: "OPeRA (66 usuarios, 692 sesiones)",
    url: "https://huggingface.co/datasets/NEU-HAI/OPeRA",
    license: "CC BY 4.0",
    use: "click con posición y scroll_detail dx/dy con timestamp",
  },
  {
    source: "The Attentive Cursor Dataset (2.909 observaciones)",
    url: "https://gitlab.com/iarapakis/the-attentive-cursor-dataset",
    license: "CC BY 4.0 (artículo)",
    use: "x/y/t con eventos click/scroll; mousemove sondeado cada 150ms",
  },
] as const;

// Las referencias son solo citas: impedir que un script las altere en caliente.
for (const reference of FURTHER_REFERENCES) Object.freeze(reference);
Object.freeze(FURTHER_REFERENCES);
Object.freeze(CMU_KEYBOARD_REFERENCE.holdMs);
Object.freeze(CMU_KEYBOARD_REFERENCE.keyIntervalMs);
Object.freeze(CMU_KEYBOARD_REFERENCE);
Object.freeze(AGENT_KEYBOARD_REFERENCE.interKeyMs);
Object.freeze(AGENT_KEYBOARD_REFERENCE.holdMs);
Object.freeze(AGENT_KEYBOARD_REFERENCE);
