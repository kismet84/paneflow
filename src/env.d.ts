/// <reference types="vite/client" />

import type { CodexPaneApi } from "../electron/preload/index";

declare global {
  interface Window {
    codexPane: CodexPaneApi;
  }
}

export {};

