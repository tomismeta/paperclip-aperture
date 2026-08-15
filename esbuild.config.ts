import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");
const { worker, manifest, ui } = presets.esbuild;

if (!worker || !manifest || !ui) {
  throw new Error("Plugin bundler presets are missing required esbuild targets.");
}

function buildOptions(
  options: esbuild.BuildOptions,
  buildTarget: "manifest" | "ui" | "worker",
): esbuild.BuildOptions {
  const runtimeOptions = buildTarget === "worker"
    ? {
        ...options,
        // The SDK is installed alongside the plugin and belongs to the host
        // runtime boundary; bundling it also pulls the full shared validator
        // graph into every worker.
        external: [...new Set([...(options.external ?? []), "@paperclipai/plugin-sdk"])],
      }
    : options;

  if (watch) return runtimeOptions;

  return {
    ...runtimeOptions,
    legalComments: "none",
    minify: buildTarget !== "ui",
    sourcemap: false,
  };
}

const workerContext = await esbuild.context(buildOptions(worker, "worker"));
const manifestContext = await esbuild.context(buildOptions(manifest, "manifest"));
const uiContext = await esbuild.context(buildOptions(ui, "ui"));

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
