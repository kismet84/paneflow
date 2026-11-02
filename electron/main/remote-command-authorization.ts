export const assertRemoteCommandAuthorized = (state: { currentPeer: boolean; authenticated: boolean; enabled: boolean; ownsRemoteAccess: boolean; deviceAuthorized: boolean }): void => {
  if (!state.currentPeer || !state.authenticated || !state.enabled || !state.ownsRemoteAccess || !state.deviceAuthorized) throw new Error("设备连接或授权已失效，请重新登录。");
};
