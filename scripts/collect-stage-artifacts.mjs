import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

// Collect only explicit build outputs; never archive the deployment/data directory.
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a release version');
const variant = process.env.PANEFLOW_APK_VARIANT || 'debug';
if (!['debug', 'release'].includes(variant)) throw new Error('Unsupported APK variant');
const androidMetadata = JSON.parse(await readFile(resolve(root, `companion/android/app/build/outputs/apk/${variant}/output-metadata.json`), 'utf8'));
if (androidMetadata.applicationId !== 'com.codexpane.companion' || androidMetadata.elements?.length !== 1 || androidMetadata.elements[0].versionName !== version) {
  throw new Error('Android package identity/version does not match this stage; rebuild before collecting');
}
const output = resolve(root, 'release', `stage-${version}`);
await mkdir(output, { recursive: true });
const sources = [
  [resolve(root, 'release', `PaneFlow-Desktop-${version}-Setup.exe`), `PaneFlow-Desktop-${version}-Setup.exe`],
  [resolve(root, `companion/android/app/build/outputs/apk/${variant}/app-${variant}.apk`), `PaneFlow-Android-${version}.apk`]
];
const artifacts = [];
for (const [source, name] of sources) {
  await stat(source); // Missing artifacts are a failed collection, never silently omitted.
  await copyFile(source, resolve(output, name));
  const bytes = await readFile(resolve(output, name));
  artifacts.push({ name: basename(name), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(resolve(output, 'SHA256SUMS.txt'), artifacts.map(x => `${x.sha256}  ${x.name}`).join('\n') + '\n');
await writeFile(resolve(output, 'artifacts.json'), JSON.stringify({ version, androidVersionCode: androidMetadata.elements[0].versionCode, protocolVersion: 1, generatedAt: new Date().toISOString(), artifacts }, null, 2) + '\n');
console.log(output);
