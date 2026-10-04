import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

export default defineConfig({
  plugins: [
    tailwindcss(),
    paraglideVitePlugin({ project: "./project.inlang", outdir: "./src/lib/paraglide", emitTsDeclarations: true }),
    sveltekit()
  ],
  server: { host: "0.0.0.0", port: 62016 },
  preview: { host: "0.0.0.0", port: 62016 }
});
