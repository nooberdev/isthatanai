// Entrada SOLO para el bundle <script>: asigna el global explícitamente porque
// el flag --global-name de Bun 1.4 no registra nada en IIFE. El entry ESM del
// paquete sigue siendo `index.ts`, que no toca globalThis al importarse.

import * as api from "./index";

(globalThis as unknown as Record<string, unknown>).IsThatAnAI = api;
