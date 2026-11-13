/**
 * Protocol/profile decoupling contracts:
 * 1. The same volcengine-ark-compatible adapter serves TWO different
 *    ProviderProfiles (different baseUrls/paths) without any change.
 * 2. The same openai-video-compatible adapter serves zgci-h3 AND a fully
 *    custom H3 profile.
 * 3. Core modules contain no vendor special-casing (bza/zgci only appear in
 *    config presets, never in backends/ or jobs.ts logic).
 * @module
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { createBackendRegistry } from '../lib/backends/index.js';
import { JobManager } from '../lib/jobs.js';

const BYTES = Buffer.from([0x00, 0xff, 0x80, 0xe7, 0xa0, 0x8d, 0x41]);

test('contract: ONE ark ProtocolAdapter reused by TWO different ProviderProfiles', async (t) => {
  let hits = { a: 0, b: 0 };
  const mk = (tag) => createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/contents/generations/tasks') {
      hits[tag]++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, 'doubao-seedance-2.0');
        assert.ok(Array.isArray(parsed.content) && parsed.content[0].type === 'text');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `ark-${tag}-1`, status: 'succeeded', content: { video_url: `http://127.0.0.1:${addr[tag].port}/dl` } }));
      });
    } else if (req.url === '/dl') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BYTES);
    } else if (req.method === 'GET' && req.url === '/contents/generations/tasks/ark-' + tag + '-1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `ark-${tag}-1`, status: 'succeeded', content: { video_url: `http://127.0.0.1:${addr[tag].port}/dl` } }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  const servers = { a: mk('a'), b: mk('b') };
  const addr = {};
  for (const k of Object.keys(servers)) await new Promise((r) => servers[k].listen(0, '127.0.0.1', r));
  for (const k of Object.keys(servers)) addr[k] = servers[k].address();
  t.after(() => { for (const s of Object.values(servers)) s.close(); });

  const outputDir = await mkdtemp(join(tmpdir(), 'ark-reuse-'));
  const cfg = resolveConfig({
    outputDir,
    backends: {
      'custom-ark-1': { protocol: 'volcengine-ark-compatible', model: 'doubao-seedance-2.0', modalities: ['video'], baseUrl: `http://127.0.0.1:${addr.a.port}`, authStyle: 'none', online: true, timeoutMs: 60_000, pollIntervalMs: 50, protocolVerified: true, paths: { submit: '/contents/generations/tasks', status: '/contents/generations/tasks/{id}', content: '/contents/generations/tasks/{id}', cancel: '/contents/generations/tasks/{id}' } },
      'custom-ark-2': { protocol: 'volcengine-ark-compatible', model: 'doubao-seedance-2.0', modalities: ['video'], baseUrl: `http://127.0.0.1:${addr.b.port}`, authStyle: 'none', online: true, timeoutMs: 60_000, pollIntervalMs: 50, protocolVerified: true, paths: { submit: '/contents/generations/tasks', status: '/contents/generations/tasks/{id}', content: '/contents/generations/tasks/{id}', cancel: '/contents/generations/tasks/{id}' } },
    },
  });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  for (const id of ['custom-ark-1', 'custom-ark-2']) {
    const rec = await jobs.wait((await jobs.start({ backend: id, model: 'doubao-seedance-2.0', modality: 'video', prompt: 'p', durationSeconds: 4 })).id);
    assert.equal(rec.status, 'succeeded', `${id} must succeed via the SAME ark adapter`);
    const artifact = readFileSync(rec.artifacts[0].path);
    assert.ok(artifact.equals(BYTES), 'binary artifact intact through both profiles');
  }
  assert.deepEqual(hits, { a: 1, b: 1 }, 'each profile hit only its own gateway — pure config-level reuse');
});

test('contract: ONE openai-video adapter reused by zgci-h3 AND a custom H3 profile', async (t) => {
  let zgciHits = 0, customHits = 0;
  const mk = (counter) => createServer((req, res) => {
    counter();
    if (req.method === 'POST' && req.url === '/v1/videos') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'task-x', status: 'queued' }));
    } else if (req.method === 'GET' && req.url === '/v1/videos/task-x') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'task-x', status: 'completed', progress: 100 }));
    } else if (req.url === '/v1/videos/task-x/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BYTES);
    } else { res.writeHead(404); res.end(); }
  });
  const s1 = mk(() => zgciHits++);
  const s2 = mk(() => customHits++);
  await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const p1 = s1.address(), p2 = s2.address();
  t.after(() => { s1.close(); s2.close(); });

  const outputDir = await mkdtemp(join(tmpdir(), 'ov-reuse-'));
  const cfg = resolveConfig({
    outputDir,
    backends: {
      // zgci preset overridden to the mock URL — same preset, same adapter.
      'zgci-h3': { baseUrl: `http://127.0.0.1:${p1.port}`, authStyle: 'none', pollIntervalMs: 50 },
      // A fully custom H3 profile — zero new adapter code.
      'my-h3-gateway': { protocol: 'openai-video-compatible', model: 'minimax-h3', modalities: ['video'], baseUrl: `http://127.0.0.1:${p2.port}`, authStyle: 'none', online: true, timeoutMs: 60_000, pollIntervalMs: 50, protocolVerified: true, paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content' } },
    },
  });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  for (const id of ['zgci-h3', 'my-h3-gateway']) {
    const rec = await jobs.wait((await jobs.start({ backend: id, model: 'minimax-h3', modality: 'video', prompt: 'p', durationSeconds: 4, size: '1280x720' })).id);
    assert.equal(rec.status, 'succeeded', `${id} must succeed via the SAME openai-video adapter`);
    assert.ok(readFileSync(rec.artifacts[0].path).equals(BYTES));
  }
  assert.equal(zgciHits, 3);
  assert.equal(customHits, 3);
});

test('architecture: core modules contain no provider special-casing', async () => {
  const { readFile } = await import('node:fs/promises');
  const coreFiles = [
    '../lib/backends/ark.js',
    '../lib/backends/task-api.js',
    '../lib/backends/openai-compatible.js',
    '../lib/backends/index.js',
    '../lib/jobs.js',
    '../lib/http.js',
    '../lib/tools.js',
  ];
  const here = new URL('.', import.meta.url);
  for (const f of coreFiles) {
    const text = await readFile(new URL(f, here), 'utf8');
    // Strip comments, then assert no provider id drives any logic.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const vendor of ['bza', 'zgci', 'seedance', 'seedream', 'hub.']) {
      assert.ok(!code.includes(vendor), `${f} must not special-case '${vendor}' in code (comments ok)`);
    }
  }
});
