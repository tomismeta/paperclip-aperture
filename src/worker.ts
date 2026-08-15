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

const plugin = definePlugin({
  async setup(ctx) {
    const store = new ApertureCompanyStore();
    registerDataHandlers(ctx, store);
    registerActionHandlers(ctx, store);
    registerEventHandlers(ctx, store, async (companyId) => {
      try {
        return normalizeConfig(await ctx.config.get(companyId));
      } catch (error) {
        ctx.logger.warn("Failed to load Focus config for company; event handlers will use defaults.", {
          companyId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {};
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip Aperture worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
