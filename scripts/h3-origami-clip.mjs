#!/usr/bin/env node
/**
 * One user-requested MiniMax-H3 clip from the 学院 hub (hub.zgci.org): an
 * origami subject folded out of a sheet of paper.
 *
 * H3's documented minimum duration is 4 s (`src/presets.ts`: MiniMax-H3,
 * 4–15 s), so this submits 4 s and trims the delivered clip to the requested
 * 2 s locally with an ffmpeg stream copy.
 *
 * The Bearer credential is read ONLY from SYNTHMEDIA_ZGCI_API_KEY in the
 * environment (the caller maps it from the DSH credential store). This script
 * never prints, logs, or writes the value.
 *
 * Usage:
 *   SYNTHMEDIA_ZGCI_API_KEY=… node scripts/h3-origami-clip.mjs \
 *     --prompt "<folding description>" --slug horse [--seconds 2]
 */
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';

const { resolveConfig } = await import('../lib/config.js');
const { createBackendRegistry } = await import('../lib/backends/index.js');
const { JobManager } = await import('../lib/jobs.js');

const OUT_ROOT = resolve(process.env['SYNTHMEDIA_OUTPUT_DIR'] || 'synthmedia-output');
const WAIT_CAP_MS = 75 * 60 * 1000;
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const REQUESTED_SECONDS = Number(argOf('seconds', '2'));
const SLUG = String(argOf('slug', 'origami')).replace(/[^a-z0-9-]/gi, '');
const SOURCE_SECONDS = 4;

const PROMPT = argOf('prompt', '');
if (!PROMPT) {
  console.log('NO-PROMPT: pass --prompt "<folding description>"');
  process.exit(2);
}

const KEY = process.env['SYNTHMEDIA_ZGCI_API_KEY'] || '';
if (!KEY) {
  console.log('NO-CREDENTIAL: SYNTHMEDIA_ZGCI_API_KEY is not set; refusing to submit');
  process.exit(5);
}

const startedAt = Date.now();
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const cfg = resolveConfig({ outputDir: OUT_ROOT, backends: { 'zgci-h3': { timeoutMs: WAIT_CAP_MS } } });
const registry = createBackendRegistry(cfg);
const jobs = new JobManager(cfg, registry);

log('output root:', OUT_ROOT);
log('backend: zgci-h3 | model: minimax-h3 | requested:', `${SOURCE_SECONDS}s source → ${REQUESTED_SECONDS}s final`);
log('prompt chars:', PROMPT.length, '| slug:', SLUG);

let rec;
try {
  rec = await jobs.start({
    backend: 'zgci-h3',
    model: 'minimax-h3',
    modality: 'video',
    prompt: PROMPT,
    durationSeconds: SOURCE_SECONDS,
    size: '1280x720',
  });
} catch (err) {
  log('REJECTED before submit:', err?.code ?? 'unknown', String(err?.message ?? err));
  process.exit(3);
}
log('job:', rec.id, 'status:', rec.status);

// Wait for the remote task id (the submit itself is asynchronous in the job).
const submitDeadline = Date.now() + 5 * 60 * 1000;
let lastLog = 0;
let remoteId;
for (;;) {
  rec = await jobs.get(rec.id);
  remoteId = rec?.remoteId;
  if (remoteId) {
    log('remote task:', remoteId);
    break;
  }
  if (rec?.status === 'failed') {
    log('FAILED before remote id:', rec?.error?.code ?? 'unknown', String(rec?.error?.message ?? ''));
    process.exit(4);
  }
  if (Date.now() > submitDeadline) {
    log('TIMEOUT waiting for the remote task id; NOT resubmitting');
    process.exit(6);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// Poll to a terminal state. The hub can sit at progress 0 for tens of minutes.
const deadline = startedAt + WAIT_CAP_MS;
for (;;) {
  rec = await jobs.get(rec.id);
  if (!rec || rec.status === 'succeeded' || rec.status === 'failed' || rec.status === 'canceled') break;
  if (Date.now() - lastLog > 60_000) {
    lastLog = Date.now();
    log('progress:', rec.progress ?? 0, '| status:', rec.status, '| elapsed:', Math.round((Date.now() - startedAt) / 1000) + 's');
  }
  if (Date.now() > deadline) {
    log('TIMEOUT after', Math.round(WAIT_CAP_MS / 60000), 'min; job', rec.id, 'left as-is on disk');
    process.exit(7);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}

log('final status:', rec?.status, '| error:', rec?.error ? `${rec.error.code}: ${rec.error.message}` : 'none');
const artifacts = rec?.artifacts ?? [];
for (const art of artifacts) log('artifact:', art.name, '|', art.path, '|', art.bytes ?? '?', 'bytes');
if (rec?.status !== 'succeeded' || artifacts.length === 0) {
  log('no artifact to trim');
  process.exit(rec?.status === 'succeeded' ? 8 : 4);
}

const source = artifacts.find((a) => /\.(mp4|mov|webm)$/i.test(a.path || a.name || ''));
if (!source) {
  log('no video artifact among', artifacts.map((a) => a.name));
  process.exit(8);
}

const trimmed = join(resolve(OUT_ROOT), rec.id, `${SLUG}-${REQUESTED_SECONDS}s.mp4`);
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source.path, '-t', String(REQUESTED_SECONDS), '-c', 'copy', trimmed], { encoding: 'utf8' });
if (ff.status !== 0) {
  log('ffmpeg trim failed:', (ff.stderr || '').slice(0, 300));
  process.exit(9);
}
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'default=nw=1', trimmed], { encoding: 'utf8' });
log('trimmed:', trimmed);
log('probe:', (probe.stdout || '').trim().replace(/\n/g, ' | '));
log('done in', Math.round((Date.now() - startedAt) / 1000), 's');
