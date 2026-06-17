import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ApertureCompanyStore } from "./aperture/core-store.js";
import { registerActionHandlers } from "./handlers/actions.js";
import { registerDataHandlers } from "./handlers/data.js";
import { registerEventHandlers } from "./handlers/events.js";

function normalizeConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

let eventConfig: Record<string, unknown> = {};

const plugin = definePlugin({
  async setup(ctx) {
    const store = new ApertureCompanyStore();
    try {
      eventConfig = normalizeConfig(await ctx.config.get());
    } catch (error) {
      eventConfig = {};
      ctx.logger.warn("Failed to load initial Focus config; event handlers will use defaults.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    registerDataHandlers(ctx, store);
    registerActionHandlers(ctx, store);
    registerEventHandlers(ctx, store, () => eventConfig);
  },

  async onConfigChanged(newConfig) {
    eventConfig = normalizeConfig(newConfig);
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip Aperture worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
