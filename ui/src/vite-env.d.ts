/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WebSocket endpoint the dashboard + arcade subscribe to. Set at build
   * time. Defaults to `ws://localhost:8787` for local dev; production
   * deployments override (e.g. `VITE_WS_URL=wss://sealedbid.liquidated.xyz/ws`).
   */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
