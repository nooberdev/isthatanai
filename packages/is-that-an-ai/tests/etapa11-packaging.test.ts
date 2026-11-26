import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createReactDetector } from "../src/frameworks/react";
import { createSvelteDetector } from "../src/frameworks/svelte";
import { createVueDetector } from "../src/frameworks/vue";
import { installGlobal } from "../src/global";
import { IsThatAnAI } from "../src/index";

type JsonRecord = Record<string, unknown>;

const readJson = (url: URL): JsonRecord => JSON.parse(readFileSync(url, "utf8")) as JsonRecord;

const libPkg = readJson(new URL("../package.json", import.meta.url));
const rootPkg = readJson(new URL("../../../package.json", import.meta.url));
const licenseText = readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8");

type Globals = typeof globalThis & { window?: unknown };

describe("Etapa 11 — empaquetado y publicación", () => {
  it("package.json de la librería expone los campos publicables", () => {
    expect(libPkg.name).toBe("is-that-an-ai");
    expect(libPkg.version).toBe("0.1.0");
    expect(libPkg.license).toBe("MIT");
    expect(libPkg.type).toBe("module");
    expect(libPkg.sideEffects).toBe(false);
    expect(libPkg.files).toEqual(["dist"]);
    expect(libPkg.main).toBe("./dist/index.js");
    expect(libPkg.module).toBe("./dist/index.js");
    expect(libPkg.types).toBe("./dist/index.d.ts");

    const exports = libPkg.exports as Record<string, Record<string, string> | string>;
    const dot = exports["."] as Record<string, string>;
    const globalEntry = exports["./global"] as Record<string, string>;
    expect(dot.types).toBe("./dist/index.d.ts");
    expect(dot.import).toBe("./dist/index.js");
    expect(exports["./iife"]).toBe("./dist/index.iife.js");
    expect(globalEntry.default).toBe("./dist/global.iife.js");
    expect(globalEntry.types).toBe("./dist/global.d.ts");

    const scripts = libPkg.scripts as Record<string, string>;
    expect(scripts.build).toContain("build:iife-global");
    // Bun 1.4 ignora --global-name en IIFE: los entries asignan el global a mano.
    expect(scripts["build:iife"]).toContain("./src/iife-entry.ts");
    expect(scripts["build:iife-global"]).toContain("./src/global-iife-entry.ts");
    expect(scripts["build:iife-global"]).toContain("--outfile ./dist/global.iife.js");
    expect(readFileSync(new URL("../dist/global.iife.js", import.meta.url), "utf8")).toContain(
      "IsThatAnAIGlobal",
    );
    expect(exports["./global"]).toBeDefined();
    expect(scripts["build:types"]).toContain("--emitDeclarationOnly");
  });

  it("el script check:package está en el package.json raíz", () => {
    const scripts = rootPkg.scripts as Record<string, string>;
    expect(scripts["check:package"]).toBe(
      "bun tools/check-bundle.ts && bun run --filter=is-that-an-ai build",
    );
  });

  it("LICENSE contiene el texto MIT estándar", () => {
    expect(licenseText).toContain("MIT License");
    expect(licenseText).toContain("Copyright (c) 2026 is-that-an-ai contributors");
    expect(licenseText).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
    expect(licenseText).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(licenseText).toContain("AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM");
  });

  it("installGlobal adjunta la instancia a window con el nombre por defecto y con uno personalizado", () => {
    const globals = globalThis as Globals;
    const hadWindow = "window" in globals;
    const previous = globals.window;
    const fakeWindow: Record<string, unknown> = {};
    globals.window = fakeWindow;
    try {
      const detector = installGlobal();
      expect(detector).toBeInstanceOf(IsThatAnAI);
      expect(fakeWindow.isThatAnAI).toBe(detector);

      const named = installGlobal("miDetector");
      expect(fakeWindow.miDetector).toBe(named);
      expect(named).not.toBe(detector);
    } finally {
      if (hadWindow) globals.window = previous;
      else Reflect.deleteProperty(globals, "window");
    }
  });

  it("installGlobal lanza un error claro sin window (SSR)", () => {
    const globals = globalThis as Globals;
    const hadWindow = "window" in globals;
    const previous = globals.window;
    Reflect.deleteProperty(globals, "window");
    try {
      expect(() => installGlobal()).toThrow(/window/);
      expect(() => installGlobal()).toThrow(/SSR/);
    } finally {
      if (hadWindow) globals.window = previous;
    }
  });

  it("los adaptadores crean, inician y detienen la MISMA instancia", () => {
    const factories = [createReactDetector, createSvelteDetector, createVueDetector];
    for (const factory of factories) {
      const handle = factory();
      expect(handle.instance).toBeInstanceOf(IsThatAnAI);

      const calls: string[] = [];
      const instance = handle.instance;
      instance.start = () => {
        calls.push("start");
      };
      instance.stop = () => {
        calls.push("stop");
      };
      handle.start();
      handle.stop();
      expect(calls).toEqual(["start", "stop"]);
    }
  });

  it("los adaptadores pasan las opciones a la instancia", () => {
    const handle = createReactDetector({ mouse: { bufferSize: 17 } });
    expect(handle.instance).toBeInstanceOf(IsThatAnAI);
  });

  it("los nuevos módulos se importan sin window/document/navigator (SSR)", () => {
    const modules = [
      "../src/global.ts",
      "../src/frameworks/react.ts",
      "../src/frameworks/svelte.ts",
      "../src/frameworks/vue.ts",
    ].map((p) => new URL(p, import.meta.url).href);

    const code = [
      'Reflect.deleteProperty(globalThis, "window");',
      'Reflect.deleteProperty(globalThis, "document");',
      'Reflect.deleteProperty(globalThis, "navigator");',
      ...modules.map((url) => `await import(${JSON.stringify(url)});`),
    ].join("\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", code],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    expect(result.exitCode).toBe(0);
  });

  it("el bundle IIFE global se genera en dist/global.iife.js", () => {
    const url = new URL("../dist/global.iife.js", import.meta.url);
    expect(existsSync(url)).toBe(true);
    const bundle = readFileSync(url, "utf8");
    expect(bundle).toContain("installGlobal");
    expect(bundle).toContain("isThatAnAI");
  });
});
