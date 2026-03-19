import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ApertureCompanyStore } from "./aperture/core-store.js";
import { registerActionHandlers } from "./handlers/actions.js";
import { registerDataHandlers } from "./handlers/data.js";
import { registerEventHandlers } from "./handlers/events.js";

const plugin = definePlugin({
  async setup(ctx) {
    const store = new ApertureCompanyStore();

    registerDataHandlers(ctx, store);
    registerActionHandlers(ctx, store);
    registerEventHandlers(ctx, store);
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip Aperture worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
