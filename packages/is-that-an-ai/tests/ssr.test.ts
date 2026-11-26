import { describe, expect, it } from "bun:test";

describe("import SSR", () => {
  it("importar el módulo sin window/document/navigator no lanza", () => {
    // Proceso aparte: evita la caché de módulos del runner y garantiza que no
    // haya globals de DOM inyectados por el entorno de tests.
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      `await import(${JSON.stringify(entry)});`,
    ].join("\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
  });
});
