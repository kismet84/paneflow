import { pathToFileURL } from "node:url";
import { join } from "node:path";

export const rendererEntryUrl = (applicationPath: string, loadBundledRenderer: boolean): string => loadBundledRenderer
  ? pathToFileURL(join(applicationPath, "dist", "index.html")).toString()
  : "http://127.0.0.1:5173/";

export const isTrustedRendererUrl = (rawUrl: string, expectedEntryUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    const expected = new URL(expectedEntryUrl);
    url.hash = "";
    expected.hash = "";
    return url.toString() === expected.toString();
  } catch {
    return false;
  }
};
