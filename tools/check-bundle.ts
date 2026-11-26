// Verificación del paquete publicable: IIFE con global, tamaño y exports ESM.
// Uso: bun run build && bun tools/check-bundle.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const iifePath = resolve(root, "packages/is-that-an-ai/dist/index.iife.js");
const esmPath = resolve(root, "packages/is-that-an-ai/dist/index.js");
const dtsPath = resolve(root, "packages/is-that-an-ai/dist/index.d.ts");

for (const p of [iifePath, esmPath, dtsPath]) {
  if (!existsSync(p)) throw new Error(`Falta ${p} — ejecuta primero bun run build`);
}

const iife = readFileSync(iifePath, "utf8");
if (!iife.includes("IsThatAnAI")) throw new Error("El IIFE no expone el global IsThatAnAI");
const esm = readFileSync(esmPath, "utf8");
if (!esm.includes("IsThatAnAI")) throw new Error("El ESM no exporta IsThatAnAI");

const kb = statSync(iifePath).size / 1024;
const esmKb = statSync(esmPath).size / 1024;
console.log(`IIFE minificado: ${kb.toFixed(2)} KB`);
console.log(`ESM: ${esmKb.toFixed(2)} KB`);
console.log(`Límite del IIFE minificado (12 idiomas + medidas avanzadas): 250 KB`);
if (kb >= 250) throw new Error("El IIFE supera 250 KB");
if (esmKb > 500) throw new Error("El ESM supera 500 KB");
console.log("OK: global, exports y tamaño verificados");
