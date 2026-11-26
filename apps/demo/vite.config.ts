import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },

      // SvelteKit 3 lee la configuración del plugin, no de svelte.config.js.
      adapter: adapter(),
      paths: {
        // Vite corre en Node; se lee sin depender de @types/node.
        base: ((
          globalThis as unknown as {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process?.env?.BASE_PATH ?? "") as "" | `/${string}`,
      },
    }),
  ],
});
