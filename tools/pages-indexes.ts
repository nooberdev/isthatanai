// GitHub Pages serves /docs/ from docs/index.html. The static adapter emits
// docs.html, so create directory indexes after a successful demo build.
// Source-of-truth pages stay in apps/demo/src/routes; this is output shaping.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const buildDir = resolve(import.meta.dirname, "../apps/demo/build");
const routes = ["docs", "not-docs", "calibrar-teclado"];

for (const route of routes) {
  const source = resolve(buildDir, `${route}.html`);
  const target = resolve(buildDir, route, "index.html");
  if (!existsSync(source)) continue;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`${route}.html -> ${route}/index.html`);
}
