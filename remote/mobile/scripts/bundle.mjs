import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let html = await readFile(resolve(root, "dist", "index.html"), "utf8");
html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]+>/, "");
const stylesheet = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
if (stylesheet) {
  const css = await readFile(resolve(root, "dist", stylesheet[1].replace(/^\//, "")), "utf8");
  html = html.replace(stylesheet[0], () => `<style>${css}</style>`);
}
const moduleScript = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
if (!moduleScript) throw new Error("Mobile entry script was not found");
const script = await readFile(resolve(root, "dist", moduleScript[1].replace(/^\//, "")), "utf8");
html = html.replace(moduleScript[0], "");
html = html.replace("</body>", () => `<script>${script.replaceAll("</script", "<\\/script")}</script></body>`);
if (html.includes('<script type="module"') || /\bexport\s+default\b/.test(script)) throw new Error("Mobile bundle must be a classic self-contained script");
const output = resolve(root, "dist-bundle", "mobile.html");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html, "utf8");
