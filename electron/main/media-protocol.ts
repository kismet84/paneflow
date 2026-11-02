export const mediaRequestId = (rawUrl: string, method: string): string | null => {
  try {
    const url = new URL(rawUrl);
    const id = url.pathname.replace(/^\//, "");
    if (method !== "GET"
      || url.protocol !== "codex-media:"
      || url.hostname !== "media"
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return id;
  } catch {
    return null;
  }
};
