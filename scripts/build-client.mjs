#!/usr/bin/env node
// Build the client half (lib/client.js) from the template client/client.js:
// bake a snapshot of the built-in ProviderProfiles and the DSH providers into
// the __PAGE_DATA__ placeholder. Built-ins come from lib/config.js +
// lib/presets.js (the SAME code paths the server uses), so the card never
// drifts from the presets. DSH providers are read from the profile patch if
// reachable (read-only); otherwise the list stays empty and the card points
// users at the live /synthmedia providers command.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { defaultConfig } = await import('../lib/config.js');

const cleanEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  // Bake presets with credential env NAMES untouched but no base-URL/model
  // overrides, so the snapshot is the documented default shape.
  if (k.startsWith('SYNTHMEDIA_') && !k.endsWith('_API_KEY_ENV')) continue;
  cleanEnv[k] = v;
}
const savedEnv = { ...process.env };
for (const k of Object.keys(process.env)) {
  if (k.startsWith('SYNTHMEDIA_') && !k.endsWith('_API_KEY_ENV') && !k.endsWith('_API_KEY')) delete process.env[k];
}
let cfg;
try {
  cfg = defaultConfig({});
} finally {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

const builtins = Object.values(cfg.backends).map((b) => ({
  id: b.id,
  protocol: b.protocol,
  baseUrl: b.baseUrl,
  models: [...(b.models ?? [b.model])],
  modalities: [...b.modalities],
  ...(b.authEnv ? { authEnv: b.authEnv } : {}),
  online: b.online,
  protocolVerified: b.protocolVerified === true,
  liveVerified: b.liveVerified === true,
  blockRealSubmit: b.blockRealSubmit === true,
}));

// DSH providers snapshot (best-effort, never fails the build).
let providers = [];
const patchPath = process.env['SYNTHMEDIA_PROVIDERS_PATCH_PATH'] ?? join(process.env['HOME'] ?? '', '.dsh/profiles/web/cordis.patch.yml');
try {
  const { readDshProviders } = await import('../lib/page/providers.js');
  providers = readDshProviders(patchPath);
} catch {
  providers = [];
}

const template = readFileSync(join(root, 'client', 'client.js'), 'utf8');
const payload = JSON.stringify({ builtins, providers, generatedAt: new Date().toISOString() });
if (!template.includes('/*__PAGE_DATA__*/')) {
  console.error('build-client: template placeholder missing');
  process.exit(1);
}
const out = template.replace('/*__PAGE_DATA__*/', `/*__PAGE_DATA__*/`);
// JSON inside JS: the payload is plain JSON, safe to inline as an expression.
const out2 = out.replace(
  /const PAGE_DATA = \/\*__PAGE_DATA__\*\/.*;/,
  'const PAGE_DATA = /*__PAGE_DATA__*/ ' + payload + ';',
);
mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib', 'client.js'), out2, 'utf8');
console.log(`build-client: lib/client.js written (${builtins.length} built-in profiles, ${providers.length} DSH providers)`);
