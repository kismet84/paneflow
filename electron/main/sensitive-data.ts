const SECRET_ASSIGNMENT = /(access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|password|secret)(\s*[:=]\s*)\S+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const redactSensitiveText = (value: string, redactUserProfile = false): string => {
  let text = value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[已隐藏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(SECRET_ASSIGNMENT, "$1$2[已隐藏]")
    .replace(JWT, "[JWT 已隐藏]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[已隐藏]");
        return url.toString();
      } catch {
        return rawUrl;
      }
    });
  if (redactUserProfile && process.env.USERPROFILE) {
    const profile = process.env.USERPROFILE;
    text = text
      .replace(new RegExp(escapeRegExp(profile), "gi"), "%USERPROFILE%")
      .replace(new RegExp(escapeRegExp(profile.replaceAll("\\", "/")), "gi"), "%USERPROFILE%");
  }
  return text;
};
