import DOMPurify from "dompurify";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

marked.setOptions({ gfm: true, breaks: true });
Object.entries({ bash, css, diff, java, javascript, json, powershell, python, rust, sql, typescript, xml }).forEach(([name, language]) => hljs.registerLanguage(name, language));
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang?.match(/^[\w-]+/)?.[0];
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text);
      return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${highlighted}</code></pre>`;
    }
  }
});

export const renderMarkdown = (source: string): string => DOMPurify.sanitize(marked.parse(source, { async: false }) as string, {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
  FORBID_ATTR: ["style", "onerror", "onclick", "onload"]
});

const markdownCache = new Map<string, string>();
let cachedCharacters = 0;
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_CHARACTERS = 4_000_000;

export const getCachedMarkdown = (source: string): string | null => {
  const cached = markdownCache.get(source);
  if (cached === undefined) return null;
  markdownCache.delete(source);
  markdownCache.set(source, cached);
  return cached;
};

export const renderCachedMarkdown = (source: string): string => {
  const cached = getCachedMarkdown(source);
  if (cached !== null) return cached;
  const html = renderMarkdown(source);
  markdownCache.set(source, html);
  cachedCharacters += source.length + html.length;
  while (markdownCache.size > MAX_CACHE_ENTRIES || cachedCharacters > MAX_CACHE_CHARACTERS) {
    const oldest = markdownCache.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    markdownCache.delete(oldest[0]);
    cachedCharacters -= oldest[0].length + oldest[1].length;
  }
  return html;
};
