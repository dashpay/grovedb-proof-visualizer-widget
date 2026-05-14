import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
copyFileSync("src/style.css", "dist/style.css");

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

const build = async () => {
  await esbuild.build({ ...shared, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
  await esbuild.build({ ...shared, entryPoints: ["src/component.ts"], outfile: "dist/component.js" });
  // wasm.ts: keep the dynamic import to ../wasm/grovedb_proof_view_wasm.js
  // EXTERNAL so the bundler doesn't try to resolve the wasm-bindgen glue at
  // build-time. End users (or downstream bundlers) resolve it themselves.
  await esbuild.build({
    ...shared,
    entryPoints: ["src/wasm.ts"],
    outfile: "dist/wasm.js",
    external: ["../wasm/grovedb_proof_view_wasm.js"],
  });
  // Standalone IIFE bundle for plain-script-tag use:
  // <script src="grovedb-proof-visualizer.global.js"></script>
  await esbuild.build({
    ...shared,
    entryPoints: ["src/component.ts"],
    outfile: "dist/grovedb-proof-visualizer.global.js",
    format: "iife",
    globalName: "GroveDBProofVisualizer",
  });
};

if (watch) {
  const ctx = await esbuild.context({
    ...shared,
    entryPoints: ["src/index.ts", "src/component.ts"],
    outdir: "dist",
  });
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await build();
}
