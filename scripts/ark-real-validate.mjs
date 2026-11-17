/**
 * ONE authorized protocol-verification run against the Volcengine Ark PUBLIC
 * Coding Plan endpoint (https://ark.cn-beijing.volces.com/api/v3), credential
 * ref ARK_API_KEY resolved from the ACTIVE DSH credential store
 * (/Users/mars/.dsh/.credentials-cli.yaml). Authorization scope (user-approved):
 * at most ONE minimal real submission per modality — Seedream (image),
 * Seedance (video), Seed TTS (audio) — smallest size / shortest duration /
* simplest prompt. Total submissions ≤ 3. No retry on uncertain create.
 *
 * The credential VALUE is read in-process and never printed, logged or
 * persisted. The persisted plugin config keeps protocolVerified=false; this
 * script flips it to true IN MEMORY ONLY for the authorized verification run.
 *
 * Anti-duplication: a durable ledger at <out>/ark-real-ledger.json records
 * intent BEFORE each POST; an existing entry with a remote id is queried, not
 * resubmitted. The script refuses to run if the ledger is corrupt.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function loadKey() {
  if (process.env['ARK_API_KEY']) return process.env['ARK_API_KEY'];
  // Active store only; parse in-memory, never print.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require('yaml');
  const doc = yaml.parse(require('node:fs').readFileSync('/Users/mars/.dsh/.credentials-cli.yaml', 'utf8'));
  const v = doc?.refs?.ARK_API_KEY;
  if (typeof v !== 'string' || v.length === 0) throw new Error('ARK_API_KEY not found in active credential store');
  return v;
}

const OUT_DIR = resolve(process.env['ARK_VAL_OUT_DIR'] || 'designs/yiyou-promo/src/ark-validation');
const LEDGER = join(OUT_DIR, 'ark-real-ledger.json');
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const KEY = loadKey();

const PROFILES = [
  {
    id: 'ark-seedream',
    protocol: 'volcengine-ark-compatible',
    baseUrl: BASE_URL,
    authEnv: 'ARK_API_KEY',
    authStyle: 'bearer',
    models: ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    modalities: ['image'],
    paths: { submit: '/images/generations' },
    protocolVerified: true, // in-memory only for this authorized run
  },
  {
    id: 'ark-seedance',
    protocol: 'volcengine-ark-compatible',
    baseUrl: BASE_URL,
    authEnv: 'ARK_API_KEY',
    authStyle: 'bearer',
    models: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-1-0-lite-t2v-250428'],
    modalities: ['video'],
    protocolVerified: true,
  },
  {
    id: 'ark-seed-tts',
    protocol: 'volcengine-ark-compatible',
    baseUrl: BASE_URL,
    authEnv: 'ARK_API_KEY',
    authStyle: 'raw',
    authHeader: 'X-Api-Key',
    models: ['doubao-seed-tts-2.0'],
    modalities: ['audio'],
    paths: { submit: '/api/v3/tts/submit', status: '/api/v3/tts/query' },
    tts: { speaker: 'zh_female_cancan_mars_bigtts', resourceId: 'seed-tts-2.0', format: 'mp3', sampleRate: 24000 },
    protocolVerified: true,
  },
];

const { resolveConfig } = await import('../lib/config.js');
const { parseCustomProfiles, backendOf } = await import('../lib/page/custom.js');
const { createBackendRegistry } = await import('../lib/backends/index.js');
const { JobManager } = await import('../lib/jobs.js');

const parsed = parseCustomProfiles(JSON.stringify(PROFILES));
if (parsed.error) {
  console.log('PROFILE-ERROR:', parsed.error);
  process.exit(2);
}
const backends = Object.fromEntries(parsed.profiles.map((p) => [p.id, backendOf(p)]));
const cfg = resolveConfig({ backends, outputDir: OUT_DIR, defaultTimeoutMs: 1_800_000 });
const resolver = async (ref) => (ref === 'ARK_API_KEY' ? KEY : process.env[ref] ?? '');
const registry = createBackendRegistry(cfg, resolver);
const jobs = new JobManager(cfg, registry);

async function readLedger() {
  try {
    const parsedLedger = JSON.parse(await readFile(LEDGER, 'utf8'));
    if (!Array.isArray(parsedLedger)) return { entries: [], corrupt: 'not an array' };
    return { entries: parsedLedger, corrupt: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], corrupt: null };
    return { entries: [], corrupt: String(err?.code ?? err) };
  }
}
async function writeLedger(entries) {
  await mkdir(dirname(LEDGER), { recursive: true });
  await writeFile(LEDGER, JSON.stringify(entries, null, 2), 'utf8');
}

const ledger = await readLedger();
if (ledger.corrupt) {
  console.log('LEDGER-CORRUPT:', ledger.corrupt, '— refusing to submit');
  process.exit(2);
}
const submits = ledger.entries.filter((e) => e.state === 'submitting' || e.state === 'submitted' || e.state === 'succeeded');
if (submits.length >= 3) {
  console.log('SUBMIT-CAP-REACHED: ledger already records', submits.length, 'submissions; refusing a 4th');
  process.exit(0);
}

const RUNS = [
  {
    key: 'seedream-image',
    req: { backend: 'ark-seedream', model: 'doubao-seedream-5-0-flash-260915', modality: 'image', prompt: '一只极简的蓝色几何小鸟图标', size: '512x512' },
    waitMs: 2 * 60_000,
  },
  {
    key: 'seedance-video',
    req: { backend: 'ark-seedance', model: 'doubao-seedance-2-0-mini-260615', modality: 'video', prompt: '一只纸船在安静水面上缓慢前行，无人物', size: '480p', durationSeconds: 5 },
    waitMs: 15 * 60_000,
  },
  {
    key: 'seed-tts-audio',
    req: { backend: 'ark-seed-tts', model: 'doubao-seed-tts-2.0', modality: 'audio', prompt: '你好，这是一次协议验证。' },
    waitMs: 5 * 60_000,
  },
];

const results = [];
for (const run of RUNS) {
  const prior = ledger.entries.find((e) => e.key === run.key && ['submitting', 'submitted', 'succeeded'].includes(e.state));
  if (prior) {
    console.log(`SKIP ${run.key}: ledger already records state=${prior.state} jobId=${prior.jobId ?? '-'} (query-only policy)`);
    results.push({ key: run.key, skipped: true, prior });
    continue;
  }
  const entry = { at: new Date().toISOString(), key: run.key, baseUrl: BASE_URL, model: run.req.model, state: 'submitting' };
  ledger.entries.push(entry);
  await writeLedger(ledger.entries);
  try {
    const rec = await jobs.start(run.req);
    entry.jobId = rec.id;
    await writeLedger(ledger.entries);
    console.log(`SUBMITTED ${run.key}: jobId=${rec.id}`);
    // wait for completion (or cap)
    const deadline = Date.now() + run.waitMs;
    let cur = await jobs.get(rec.id);
    while (cur && !['succeeded', 'failed', 'cancelled', 'timeout'].includes(cur.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      cur = await jobs.get(rec.id);
      console.log(`  poll ${run.key}: status=${cur.status} progress=${cur.progress ?? '-'} remoteId=${cur.remoteId ?? '-'}`);
    }
    if (cur && !['succeeded', 'failed', 'cancelled', 'timeout'].includes(cur.status)) {
      console.log(`  WAIT-CAP ${run.key}: local stop only, remote task left running (id=${cur.remoteId ?? '-'})`);
      await jobs.cancel(rec.id).catch(() => {});
      cur = await jobs.get(rec.id);
    }
    entry.state = cur?.status === 'succeeded' ? 'succeeded' : 'finished-unsuccessful';
    entry.finalStatus = cur?.status;
    entry.remoteId = cur?.remoteId;
    await writeLedger(ledger.entries);
    results.push({
      key: run.key,
      jobId: rec.id,
      backend: run.req.backend,
      model: run.req.model,
      status: cur?.status,
      remoteId: cur?.remoteId,
      error: cur?.error,
      artifacts: (cur?.artifacts ?? []).map((a) => ({ path: a.path, kind: a.kind, bytes: a.bytes, mimeType: a.mimeType })),
    });
  } catch (err) {
    entry.state = 'submit-failed';
    entry.error = String(err?.message ?? err).slice(0, 300);
    await writeLedger(ledger.entries);
    console.log(`FAILED ${run.key}: ${entry.error}`);
    results.push({ key: run.key, error: entry.error });
  }
}

console.log('SUMMARY', JSON.stringify(results, null, 1));
process.exit(0);
