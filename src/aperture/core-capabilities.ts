import type { AttentionSurfaceCapabilities } from "@tomismeta/aperture-core";

export const FOCUS_SURFACE_CAPABILITIES: AttentionSurfaceCapabilities = {
  topology: {
    supportsAmbient: true,
  },
  responses: {
    supportsSingleChoice: true,
    supportsMultipleChoice: false,
    supportsForm: false,
    supportsTextResponse: true,
  },
};
