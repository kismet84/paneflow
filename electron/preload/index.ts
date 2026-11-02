import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AttachmentBatch, ConnectionState, MediaAttachment, ProtocolEvent, RemoteAccessStatus, RemoteSettings, SafeRequest, ServerResponse } from "../shared/contracts.js";
import type { WorkspaceState } from "../main/persistence.js";

const api = {
  bootstrap: (): Promise<{ appVersion: string; connection: ConnectionState; workspace: WorkspaceState | null; workspaceWarning?: string | null }> => ipcRenderer.invoke("app:bootstrap"),
  request: (request: SafeRequest): Promise<unknown> => ipcRenderer.invoke("codex:request", request),
  respond: (response: ServerResponse): Promise<void> => ipcRenderer.invoke("codex:respond", response),
  reconnect: (): Promise<void> => ipcRenderer.invoke("codex:reconnect"),
  setAppServerWorkingDirectory: (path: string | null): Promise<void> => ipcRenderer.invoke("codex:working-directory", path),
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:directory"),
  chooseAttachments: (limit: number): Promise<AttachmentBatch> => ipcRenderer.invoke("attachment:choose", limit),
  pasteAttachments: (paths: string[], limit: number): Promise<AttachmentBatch> => ipcRenderer.invoke("attachment:paste", paths, limit),
  resolveFilePaths: (files: File[]): string[] => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  importImagePath: (path: string): Promise<MediaAttachment> => ipcRenderer.invoke("media:path", path),
  addRemoteImage: (url: string): Promise<MediaAttachment> => ipcRenderer.invoke("media:remote", url),
  copyText: (value: string): Promise<void> => ipcRenderer.invoke("clipboard:write-text", value),
  saveWorkspace: (state: WorkspaceState): Promise<void> => ipcRenderer.invoke("workspace:save", state),
  setFullScreen: (fullScreen: boolean): Promise<void> => ipcRenderer.invoke("window:fullscreen", fullScreen),
  windowControl: (action: "minimize" | "maximize" | "close"): Promise<void> => ipcRenderer.invoke("window:control", action),
  respondToCloseRequest: (allow: boolean): Promise<void> => ipcRenderer.invoke("window:close-response", allow),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("external:open", url),
  listSystemFonts: (): Promise<string[]> => ipcRenderer.invoke("system:fonts"),
  readDiagnostics: (): Promise<string[]> => ipcRenderer.invoke("diagnostics:read"),
  getRemoteAccessStatus: (): Promise<RemoteAccessStatus> => ipcRenderer.invoke("remote:status"),
  updateRemoteSettings: (settings: RemoteSettings): Promise<RemoteAccessStatus> => ipcRenderer.invoke("remote:settings", settings),
  beginRemotePairing: (): Promise<RemoteAccessStatus> => ipcRenderer.invoke("remote:pairing-begin"),
  confirmRemotePairing: (pairingId: string): Promise<void> => ipcRenderer.invoke("remote:pairing-confirm", pairingId),
  revokeRemotePasskey: (credentialId: string): Promise<void> => ipcRenderer.invoke("remote:passkey-revoke", credentialId),
  logoutAllRemoteMobiles: (): Promise<void> => ipcRenderer.invoke("remote:logout-all"),
  onConnectionState: (listener: (state: ConnectionState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ConnectionState): void => listener(state);
    ipcRenderer.on("codex:state", handler);
    return () => ipcRenderer.removeListener("codex:state", handler);
  },
  onProtocolEvent: (listener: (event: ProtocolEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, protocolEvent: ProtocolEvent): void => listener(protocolEvent);
    ipcRenderer.on("codex:event", handler);
    return () => ipcRenderer.removeListener("codex:event", handler);
  },
  onFullScreenChange: (listener: (fullScreen: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, fullScreen: boolean): void => listener(fullScreen);
    ipcRenderer.on("window:fullscreen-changed", handler);
    return () => ipcRenderer.removeListener("window:fullscreen-changed", handler);
  },
  onMaximizedChange: (listener: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized);
    ipcRenderer.on("window:maximized-changed", handler);
    return () => ipcRenderer.removeListener("window:maximized-changed", handler);
  },
  onCloseRequested: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on("window:close-requested", handler);
    return () => ipcRenderer.removeListener("window:close-requested", handler);
  },
  onRemoteAccessStatus: (listener: (status: RemoteAccessStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RemoteAccessStatus): void => listener(status);
    ipcRenderer.on("remote:status-changed", handler);
    return () => ipcRenderer.removeListener("remote:status-changed", handler);
  }
};

contextBridge.exposeInMainWorld("codexPane", api);

export type CodexPaneApi = typeof api;
