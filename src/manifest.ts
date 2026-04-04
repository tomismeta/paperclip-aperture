import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "tomismeta.paperclip-aperture",
  apiVersion: 1,
  version: "0.4.0",
  displayName: "Paperclip Aperture",
  description: "The live attention layer for Paperclip, powered by Aperture's deterministic attention engine.",
  author: "@tomismeta",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "agents.read",
    "issues.read",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "telemetry.track",
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
        displayName: "Focus",
        exportName: "AttentionPage",
        routePath: "aperture"
      },
      {
        type: "sidebar",
        id: "attention-sidebar-link",
        displayName: "Focus",
        exportName: "AttentionSidebarLink"
      },
      {
        type: "dashboardWidget",
        id: "attention-widget",
        displayName: "Focus",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
