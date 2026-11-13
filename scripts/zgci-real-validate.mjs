/**
 * ONE authorized real validation run against the zgci hub minimax-h3 video
 * task API. Authorization scope: at most ONE minimal task, prompt
 * "一只纸船在安静水面上缓慢前行，无人物", wait at most 60 minutes, no retry on an
 * uncertain create outcome, never claim a remote cancel we did not perform.
 *
 * Credentials are read from the environment only (mapped by the caller from
 * PhotoStory's existing env names). Values are never printed or persisted.
 *
 * Anti-duplication (defense in depth): BEFORE anything is submitted this script
 * (1) reads the durable ledger under the output root, and (2) scans the output
 * root for evidence of an earlier real submission (job.json remote ids, task-id
 * shapes or `remoteId` fields in logs, in-flight zgci jobs). If any remote id
 * is found the only allowed action is to query it (resume) — never a second
 * create. If more than one id, a ledger entry with an unknown outcome, a corrupt
 * ledger, or unreadable evidence exists, the script refuses to create and
 * exits with a report. See `scripts/zgci-guard.mjs`.
 *
 * Paths/knobs are environment-overridable so the guard can be exercised with
 * throwaway fixtures (`SYNTHMEDIA_OUTPUT_DIR`, `SYNTHMEDIA_ZGCI_LEDGER`,
 * `SYNTHMEDIA_ZGCI_OUT_DIR`, `SYNTHMEDIA_ZGCI_POLL_MS`) without touching the
 * real ledger or any existing real task.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decidePreflight, scanExistingRuns } from './zgci-guard.mjs';

const { resolveConfig } = await import('../lib/config.js');
const { createBackendRegistry } = await import('../lib/backends/index.js');
const { JobManager } = await import('../lib/jobs.js');

const PROMPT = '一只纸船在安静水面上缓慢前行，无人物';
const WAIT_CAP_MS = 60 * 60 * 1000;
const SUBMIT_ID_WAIT_MS = 3 * 60 * 1000;
const OUTPUT_ROOT = resolve(process.env['SYNTHMEDIA_OUTPUT_DIR'] || 'synthmedia-output');
const LEDGER = resolve(process.env['SYNTHMEDIA_ZGCI_LEDGER'] || join(OUTPUT_ROOT, 'zgci-real-runs.json'));
const OUT_DIR = resolve(process.env['SYNTHMEDIA_ZGCI_OUT_DIR'] || join(OUTPUT_ROOT, 'zgci-real'));
const POLL_MS = Math.max(20, Number(process.env['SYNTHMEDIA_ZGCI_POLL_MS']) || 15_000);
const BASE_URL = process.env['SYNTHMEDIA_ZGCI_BASE_URL'] || 'https://hub.zgci.org';
const KEY = process.env['SYNTHMEDIA_ZGCI_API_KEY'] || '';

/** Read the ledger; a corrupt ledger is undetermined evidence, never "empty". */
async function readLedger() {
  let raw;
  try {
    raw = await readFile(LEDGER, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], missing: true, corrupt: null };
    return { entries: [], missing: false, corrupt: `cannot read ledger: ${err?.code ?? String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { entries: [], missing: false, corrupt: 'ledger is not a JSON array' };
    return { entries: parsed, missing: false, corrupt: null };
  } catch {
    return { entries: [], missing: false, corrupt: 'ledger is not valid JSON' };
  }
}

async function writeLedger(entries) {
  await mkdir(dirname(LEDGER), { recursive: true });
  await writeFile(LEDGER, JSON.stringify(entries, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Preflight: ledger + output-root scan. Nothing below may create a task until
// the decision is exactly 'create'.
// ---------------------------------------------------------------------------
const ledger = await readLedger();
const scan = await scanExistingRuns(OUTPUT_ROOT);
if (ledger.corrupt) {
  scan.indeterminate.push({ source: LEDGER, reason: ledger.corrupt });
}
const preflight = decidePreflight({ ledgerEntries: ledger.entries, scan, ledgerPath: LEDGER });
console.log('PREFLIGHT', JSON.stringify({
  outputRoot: OUTPUT_ROOT,
  ledger: LEDGER,
  ledgerPresent: !ledger.missing,
  scannedFiles: scan.files.length,
  remoteIds: scan.remoteIds,
  indeterminate: scan.indeterminate,
  decision: preflight.action,
  reason: preflight.reason ?? null,
}));

if (preflight.action === 'refuse') {
  console.log('DUPLICATE-GUARD: refusing to create a new real task');
  for (const note of preflight.notes ?? []) console.log('  -', note);
  process.exit(preflight.code ?? 4);
}

const cfg = resolveConfig({
  outputDir: OUT_DIR,
  backends: {
    'zgci-h3': { baseUrl: BASE_URL, pollIntervalMs: POLL_MS, timeoutMs: WAIT_CAP_MS },
  },
});
console.log('target:', cfg.backends['zgci-h3'].baseUrl, '| model: minimax-h3 | prompt:', PROMPT);
const registry = createBackendRegistry(cfg);

if (preflight.action === 'resume') {
  console.log('DUPLICATE-GUARD: an existing real task was found; resuming query only (no new submission)');
  for (const note of preflight.notes ?? []) console.log('  -', note);
  if (!KEY) {
    console.log('NO-CREDENTIAL: SYNTHMEDIA_ZGCI_API_KEY is not set; cannot query the existing task');
    process.exit(5);
  }
  const backend = registry.get('zgci-h3');
  try {
    const poll = await backend?.poll(preflight.remoteId, new AbortController().signal);
    console.log('RESUMED-QUERY-ONLY:', JSON.stringify({
      remoteId: preflight.remoteId,
      source: preflight.sources?.[0],
      status: poll?.status,
      progress: poll?.progress,
    }));
  } catch (err) {
    console.log('RESUMED-QUERY-ONLY (query failed):', JSON.stringify({
      remoteId: preflight.remoteId,
      source: preflight.sources?.[0],
      code: err?.code,
    }));
  }
  process.exit(0);
}

if (!KEY) {
  console.log('NO-CREDENTIAL: SYNTHMEDIA_ZGCI_API_KEY is not set; refusing to run');
  process.exit(5);
}

console.log('PREFLIGHT-CLEAR: no prior real submission found; the single authorized create may proceed');
const jobs = new JobManager(cfg, registry);

// Record intent BEFORE the POST so an indeterminate create can never be
// repeated by a later run.
const entry = {
  at: new Date().toISOString(),
  baseUrl: BASE_URL,
  model: 'minimax-h3',
  prompt: PROMPT,
  state: 'submitting',
};
ledger.entries.push(entry);
await writeLedger(ledger.entries);

let jobId;
try {
  const rec = await jobs.start({
    backend: 'zgci-h3',
    model: 'minimax-h3',
    modality: 'video',
    prompt: PROMPT,
    durationSeconds: 4,
    size: '1280x720',
  });
  jobId = rec.id;
  entry.jobId = jobId;
  console.log('job:', jobId);
} catch (err) {
  // A start() rejection is always before any submit (routing/validation).
  entry.state = 'rejected-no-task';
  entry.errorCode = err?.code ?? 'unknown';
  await writeLedger(ledger.entries);
  console.log('REJECTED-NO-TASK', entry.errorCode, String(err?.message ?? err));
  console.log('NOT-RETRYING per authorization terms');
  process.exit(3);
}

// Wait for the remote id (submit is asynchronous inside the job), then record
// it so a later run can never submit a duplicate.
const submitDeadline = Date.now() + SUBMIT_ID_WAIT_MS;
let rec = await jobs.get(jobId);
while (!rec?.remoteId && rec?.status === 'running' && Date.now() < submitDeadline) {
  await new Promise((r) => setTimeout(r, 1000));
  rec = await jobs.get(jobId);
}
if (rec?.remoteId) {
  entry.remoteId = rec.remoteId;
  entry.state = 'submitted';
  await writeLedger(ledger.entries);
  console.log('remoteId:', rec.remoteId);
} else if (rec?.status === 'failed') {
  // Distinguish a definite local/auth rejection (no task can exist) from an
  // indeterminate outcome (request may have reached the server). Only the
  // latter blocks future runs.
  const code = rec.error?.code ?? 'unknown';
  const msg = rec.error?.message ?? '';
  const definite = ['E_NO_CREDENTIAL', 'E_CONFIG', 'E_MODEL', 'E_MODALITY', 'E_PROTOCOL', 'E_SIZE'].includes(code)
    || /http 4\d\d/.test(msg);
  entry.state = definite ? 'rejected-no-task' : 'create-uncertain';
  entry.errorCode = code;
  await writeLedger(ledger.entries);
  console.log(definite ? 'REJECTED-NO-TASK:' : 'CREATE-UNCERTAIN (no remote id):', code, msg);
  console.log('NOT-RETRYING per authorization terms');
  process.exit(definite ? 3 : 2);
}

const deadline = Date.now() + WAIT_CAP_MS;
for (;;) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const cur = await jobs.get(jobId);
  if (!cur) break;
  console.log(`poll: status=${cur.status} progress=${cur.progress} remoteId=${cur.remoteId ?? '-'}`);
  if (['succeeded', 'failed', 'cancelled', 'timeout'].includes(cur.status)) {
    rec = cur;
    break;
  }
  if (Date.now() > deadline) {
    console.log('WAIT-CAP-REACHED: stopping the wait; the remote task was NOT cancelled by us');
    await jobs.cancel(jobId); // local stop only; no remote cancel claimed
    rec = await jobs.get(jobId);
    break;
  }
}

entry.state = rec?.status === 'succeeded' ? 'succeeded' : 'finished-unsuccessful';
entry.finalStatus = rec?.status;
entry.progress = rec?.progress;
await writeLedger(ledger.entries);

console.log('FINAL', JSON.stringify({
  jobId,
  remoteId: rec?.remoteId,
  status: rec?.status,
  progress: rec?.progress,
  error: rec?.error,
  artifacts: (rec?.artifacts ?? []).map((a) => ({ path: a.path, kind: a.kind, bytes: a.bytes, mimeType: a.mimeType })),
}, null, 1));

for (const a of rec?.artifacts ?? []) {
  try {
    const s = await stat(a.path);
    console.log('artifact-check', a.path, 'bytes=', s.size, s.size > 0 ? 'NON-EMPTY' : 'EMPTY!');
  } catch {
    console.log('artifact-check MISSING', a.path);
  }
}

if (rec?.status === 'succeeded' && (rec?.artifacts?.length ?? 0) > 0) process.exit(0);
process.exit(3);
