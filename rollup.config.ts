import { nodeResolve } from "@rollup/plugin-node-resolve";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import typescriptPlugin from "@rollup/plugin-typescript";
import type { InputPluginOption, RollupOptions } from "rollup";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
type RollupConfigLike = Record<string, unknown> & {
  plugins?: InputPluginOption;
};

const typescript = typescriptPlugin as unknown as (options: {
  tsconfig: string;
  declaration: boolean;
  declarationMap: boolean;
}) => InputPluginOption;

function withPlugins(
  config: RollupConfigLike | null | undefined,
): RollupOptions | null {
  if (!config) return null;

  return {
    ...(config as RollupOptions),
    plugins: [
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest as unknown as RollupConfigLike | undefined),
  withPlugins(presets.rollup.worker as unknown as RollupConfigLike | undefined),
  withPlugins(presets.rollup.ui as unknown as RollupConfigLike | undefined),
].filter(Boolean);
