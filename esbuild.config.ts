import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");
const { worker, manifest, ui } = presets.esbuild;

if (!worker || !manifest || !ui) {
  throw new Error("Plugin bundler presets are missing required esbuild targets.");
}

function buildOptions(options: esbuild.BuildOptions): esbuild.BuildOptions {
  if (watch) return options;

  return {
    ...options,
    legalComments: "none",
    minify: true,
    sourcemap: false,
  };
}

const workerContext = await esbuild.context(buildOptions(worker));
const manifestContext = await esbuild.context(buildOptions(manifest));
const uiContext = await esbuild.context(buildOptions(ui));

if (watch) {
  await Promise.all([
    workerContext.watch(),
    manifestContext.watch(),
    uiContext.watch(),
  ]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([
    workerContext.rebuild(),
    manifestContext.rebuild(),
    uiContext.rebuild(),
  ]);
  await Promise.all([
    workerContext.dispose(),
    manifestContext.dispose(),
    uiContext.dispose(),
  ]);
}
