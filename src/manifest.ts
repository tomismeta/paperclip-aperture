import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "tomismeta.paperclip-aperture",
  apiVersion: 1,
  version: "0.1.2",
  displayName: "Paperclip Aperture",
  description: "An Aperture-powered attention center for Paperclip operators.",
  author: "Tom Is Meta",
  categories: ["connector", "automation", "ui"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "ui.sidebar.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      captureIssueLifecycle: {
        type: "boolean",
        title: "Capture Issue Lifecycle",
        default: true,
        description: "Turn issue creation and update events into Aperture status signals."
      },
      captureRunFailures: {
        type: "boolean",
        title: "Capture Run Failures",
        default: true,
        description: "Turn failed agent runs into high-salience attention events."
      }
    }
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "attention-page",
        displayName: "Aperture",
        exportName: "AttentionPage",
        routePath: "aperture"
      },
      {
        type: "sidebar",
        id: "attention-sidebar-link",
        displayName: "Aperture",
        exportName: "AttentionSidebarLink"
      },
      {
        type: "dashboardWidget",
        id: "attention-widget",
        displayName: "Paperclip Aperture",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
