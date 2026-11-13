/**
 * Remote-vs-local time contract.
 *
 * A provider-reported terminal timestamp (`completed_at`, or the `updated_at`
 * of a terminal status) is NOT the local moment when polling and the artifact
 * download finished. Job records keep both, and neither label is used for the
 * other. Everything here runs against a local mock server: no real hub call.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** 2026-07-27T00:19:06.000Z — a remote clock value far from "now". */
const REMOTE_SECONDS = 1785125946;
const REMOTE_ISO = new Date(REMOTE_SECONDS * 1000).toISOString();

test('task-api: provider completed_at stays separate from local download/finish time', async () => {
  const polls = new Map();
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        json(res, 201, { id: `v-${payload.prompt}`, status: 'queued' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/videos/v-ok/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from([0x00, 0x01, 0x02]));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/videos/v-ok')) {
      const n = (polls.get('ok') ?? 0) + 1;
      polls.set('ok', n);
      if (n === 1) json(res, 200, { id: 'v-ok', status: 'in_progress', progress: 40 });
      // Terminal poll carries the REMOTE completion timestamp (unix seconds).
      else json(res, 200, { id: 'v-ok', status: 'completed', progress: 100, completed_at: REMOTE_SECONDS });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/videos/v-bad')) {
      const n = (polls.get('bad') ?? 0) + 1;
      polls.set('bad', n);
      if (n === 1) json(res, 200, { id: 'v-bad', status: 'in_progress', progress: 10 });
      else json(res, 200, { id: 'v-bad', status: 'failed', progress: 10, updated_at: REMOTE_SECONDS, error: { message: 'boom' } });
      return;
    }
    json(res, 404, {});
  });
  const base = await listen(server);
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const dir = await mkdtemp(join(tmpdir(), 'synth-time-'));
    const profile = (modality) => ({
      protocol: 'openai-video-compatible',
      model: 'm',
      models: ['m'],
      modalities: [modality],
      baseUrl: base,
      authStyle: 'none',
      online: true,
      protocolVerified: true,
      pollIntervalMs: 10,
      timeoutMs: 10_000,
      paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content' },
    });
    const cfg = resolveConfig({
      outputDir: dir,
      backends: { 'ts-hub': profile('video') },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const before = Date.now();

    const ok = await jobs.wait(
      (await jobs.start({ backend: 'ts-hub', model: 'm', modality: 'video', prompt: 'ok' })).id,
    );
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.remoteCompletedAt, REMOTE_ISO, 'remote completed_at is normalised to ISO and kept as provider time');
    assert.ok(ok.downloadedAt, 'local download completion time is recorded');
    assert.ok(ok.finishedAt, 'local job finish time is recorded');
    assert.ok(
      Date.parse(ok.downloadedAt) >= before,
      'downloadedAt is LOCAL time written after the bytes arrived (not the remote instant)',
    );
    assert.ok(
      Date.parse(ok.finishedAt) >= Date.parse(ok.downloadedAt),
      'finishedAt settles at/after the local download',
    );
    assert.notEqual(ok.remoteCompletedAt, ok.downloadedAt, 'the two clocks must never be conflated');
    const persisted = JSON.parse(await readFile(join(dir, ok.id, 'job.json'), 'utf8'));
    assert.equal(persisted.remoteCompletedAt, REMOTE_ISO, 'both timestamps survive on disk');
    assert.equal(persisted.downloadedAt, ok.downloadedAt);

    const bad = await jobs.wait(
      (await jobs.start({ backend: 'ts-hub', model: 'm', modality: 'video', prompt: 'bad' })).id,
    );
    assert.equal(bad.status, 'failed');
    assert.equal(bad.remoteCompletedAt, REMOTE_ISO, 'a failed task may still carry the provider updated_at');
    assert.equal(bad.downloadedAt, undefined, 'no download happened, so there is no local download time');
  } finally {
    server.close();
  }
});

test('time helper: accepts unix seconds/ms and ISO, never guesses from junk', async () => {
  const { toIsoTimestamp, remoteCompletedAtOf } = await import('../lib/time.js');
  assert.equal(toIsoTimestamp(REMOTE_SECONDS), REMOTE_ISO);
  assert.equal(toIsoTimestamp(String(REMOTE_SECONDS)), REMOTE_ISO);
  assert.equal(toIsoTimestamp(REMOTE_SECONDS * 1000), REMOTE_ISO);
  assert.equal(toIsoTimestamp(REMOTE_ISO), REMOTE_ISO);
  for (const junk of [undefined, null, 0, -5, '', 'not-a-date', {}, true, Number.NaN]) {
    assert.equal(toIsoTimestamp(junk), undefined, `${String(junk)} must not become a timestamp`);
  }
  assert.equal(remoteCompletedAtOf({ updated_at: REMOTE_SECONDS }, 'running'), undefined, 'an in-flight task has no completion instant');
  assert.equal(remoteCompletedAtOf({ updated_at: REMOTE_SECONDS }, 'succeeded'), REMOTE_ISO);
  assert.equal(remoteCompletedAtOf({ completed_at: REMOTE_SECONDS, updated_at: 1 }, 'succeeded'), REMOTE_ISO, 'completed_at wins');
  assert.equal(remoteCompletedAtOf({}, 'failed'), undefined, 'no timestamp is fabricated');
});
