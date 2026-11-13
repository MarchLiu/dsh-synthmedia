/**
 * Duplicate-submission guard tests for scripts/zgci-real-validate.mjs.
 *
 * The guarded script is spawned as a real child process against a LOCAL mock
 * hub and throwaway output roots, so the assertions prove end-to-end that an
 * existing remote submission (even with a missing ledger) yields ZERO new
 * create requests. Nothing here reads or writes the repository's real ledger
 * or the real zgci task.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { scanExistingRuns, decidePreflight } from '../scripts/zgci-guard.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0x80]);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Local hub mock: counts every request method+path, never talks to the network. */
function mockHub() {
  const state = { posts: 0, gets: 0, calls: [] };
  const server = createServer((req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/v1/videos') {
      state.posts += 1;
      req.on('data', () => {});
      req.on('end', () => json(res, 201, { id: 'task_MOCKcreated0001', status: 'queued' }));
      return;
    }
    const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(req.url ?? '');
    if (req.method === 'GET' && content) {
      state.gets += 1;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
      return;
    }
    const status = /^\/v1\/videos\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && status) {
      state.gets += 1;
      json(res, 200, { id: status[1], status: 'completed', progress: 100 });
      return;
    }
    json(res, 404, {});
  });
  return { server, state };
}

/** Run the guarded validation script in a child process with an isolated root. */
function runValidate(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(REPO, 'scripts', 'zgci-real-validate.mjs')], {
      cwd: REPO,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`validation script timed out\nstdout:\n${out}\nstderr:\n${err}`));
    }, 45_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err });
    });
  });
}

test('guard: scan finds remote ids in job.json and logs; ambiguous evidence refuses creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zgci-guard-scan-'));
  const jobDir = join(root, 'zgci-real', 'job-a');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'job.json'), JSON.stringify({
    id: 'job-a', backend: 'zgci-h3', model: 'minimax-h3', status: 'succeeded', remoteId: 'task_AAAA1111',
  }), 'utf8');
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(root, 'logs', 'run.log'), 'poll: remoteId: task_BBBB2222 status=succeeded\n', 'utf8');

  const scan = await scanExistingRuns(root);
  assert.deepEqual(scan.remoteIds.map((r) => r.id).sort(), ['task_AAAA1111', 'task_BBBB2222']);
  const ambiguous = decidePreflight({ ledgerEntries: [], scan, ledgerPath: join(root, 'missing-ledger.json') });
  assert.equal(ambiguous.action, 'refuse');
  assert.equal(ambiguous.code, 5);

  const single = await scanExistingRuns(join(root, 'zgci-real'));
  const resume = decidePreflight({ ledgerEntries: [], scan: single, ledgerPath: join(root, 'missing-ledger.json') });
  assert.equal(resume.action, 'resume');
  assert.equal(resume.remoteId, 'task_AAAA1111');

  // A job record with a remote id but no backend id cannot be ruled out.
  const unknownRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-unknown-'));
  await mkdir(join(unknownRoot, 'job-b'), { recursive: true });
  await writeFile(join(unknownRoot, 'job-b', 'job.json'), JSON.stringify({ id: 'job-b', status: 'succeeded', remoteId: 'task_CCCC3333' }), 'utf8');
  const unknownScan = await scanExistingRuns(unknownRoot);
  const refused = decidePreflight({ ledgerEntries: [], scan: unknownScan, ledgerPath: join(unknownRoot, 'missing-ledger.json') });
  assert.equal(refused.action, 'refuse');
  assert.equal(refused.code, 4);

  // Non-hub sentinels (e.g. the inline path writes remoteId="inline" on old
  // zgci-h3 dev/text records) must NOT be mistaken for remote tasks, or the
  // real resume path would be blocked by false ambiguity.
  const historyRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-history-'));
  await mkdir(join(historyRoot, 'old-text'), { recursive: true });
  await writeFile(join(historyRoot, 'old-text', 'job.json'), JSON.stringify({
    id: 'old-text', backend: 'zgci-h3', modality: 'text', status: 'succeeded', remoteId: 'inline',
  }), 'utf8');
  await mkdir(join(historyRoot, 'real-video'), { recursive: true });
  await writeFile(join(historyRoot, 'real-video', 'job.json'), JSON.stringify({
    id: 'real-video', backend: 'zgci-h3', modality: 'video', status: 'succeeded', remoteId: 'task_REALvideo01',
  }), 'utf8');
  const historyScan = await scanExistingRuns(historyRoot);
  assert.deepEqual(historyScan.remoteIds.map((r) => r.id), ['task_REALvideo01']);
  assert.deepEqual(historyScan.indeterminate, []);
  assert.equal(decidePreflight({ ledgerEntries: [], scan: historyScan, ledgerPath: 'x' }).action, 'resume');

  // An unrecognized id on a zgci VIDEO record cannot be resumed ⇒ refuse.
  const weirdRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-weird-'));
  await mkdir(join(weirdRoot, 'weird-video'), { recursive: true });
  await writeFile(join(weirdRoot, 'weird-video', 'job.json'), JSON.stringify({
    id: 'weird-video', backend: 'zgci-h3', modality: 'video', status: 'succeeded', remoteId: 'not-a-task-id',
  }), 'utf8');
  const weird = decidePreflight({ ledgerEntries: [], scan: await scanExistingRuns(weirdRoot), ledgerPath: 'x' });
  assert.equal(weird.action, 'refuse');
  assert.equal(weird.code, 4);

  // A clean root with nothing on record is the only path that may create.
  const cleanRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-clean-'));
  const clear = decidePreflight({ ledgerEntries: [], scan: await scanExistingRuns(cleanRoot), ledgerPath: join(cleanRoot, 'missing-ledger.json') });
  assert.equal(clear.action, 'create');
});

test('guard: ledger MISSING but an existing job.json has a remoteId ⇒ query only, zero new requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zgci-guard-resume-'));
  const { server, state } = mockHub();
  const base = await listen(server);
  try {
    const jobDir = join(root, 'zgci-real', 'existing-job');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'job.json'), JSON.stringify({
      id: 'existing-job',
      backend: 'zgci-h3',
      model: 'minimax-h3',
      status: 'succeeded',
      remoteId: 'task_EXISTING999',
    }), 'utf8');
    assert.ok(!(await readFile(join(root, 'zgci-real-runs.json'), 'utf8').catch(() => null)), 'fixture has no ledger');

    const { code, out, err } = await runValidate({
      SYNTHMEDIA_OUTPUT_DIR: root,
      SYNTHMEDIA_ZGCI_API_KEY: 'dummy-key-not-real',
      SYNTHMEDIA_ZGCI_BASE_URL: base,
    });

    assert.equal(code, 0, `expected the resume path, got exit ${code}\nstdout:\n${out}\nstderr:\n${err}`);
    assert.match(out, /PREFLIGHT/);
    assert.match(out, /RESUMED-QUERY-ONLY/);
    assert.match(out, /task_EXISTING999/);
    assert.equal(state.posts, 0, 'no POST /v1/videos may be sent when a remote id already exists');
    assert.equal(state.gets, 1, 'only the read-only status query is allowed');
    assert.ok(!(await readFile(join(root, 'zgci-real-runs.json'), 'utf8').catch(() => null)), 'the resume path must not write a new ledger entry');
  } finally {
    server.close();
  }
});

test('guard: corrupt/unreadable evidence refuses creation with zero requests', async () => {
  const { server, state } = mockHub();
  const base = await listen(server);
  try {
    // (a) invalid job.json evidence
    const corruptRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-corrupt-'));
    await mkdir(join(corruptRoot, 'some-job'), { recursive: true });
    await writeFile(join(corruptRoot, 'some-job', 'job.json'), '{ this is not json', 'utf8');
    const a = await runValidate({
      SYNTHMEDIA_OUTPUT_DIR: corruptRoot,
      SYNTHMEDIA_ZGCI_API_KEY: 'dummy-key-not-real',
      SYNTHMEDIA_ZGCI_BASE_URL: base,
    });
    assert.equal(a.code, 4, `unreadable job record must refuse\nstdout:\n${a.out}`);
    assert.match(a.out, /DUPLICATE-GUARD: refusing/);

    // (b) unreadable ledger
    const badLedgerRoot = await mkdtemp(join(tmpdir(), 'zgci-guard-ledger-'));
    await writeFile(join(badLedgerRoot, 'zgci-real-runs.json'), 'not-json', 'utf8');
    const b = await runValidate({
      SYNTHMEDIA_OUTPUT_DIR: badLedgerRoot,
      SYNTHMEDIA_ZGCI_API_KEY: 'dummy-key-not-real',
      SYNTHMEDIA_ZGCI_BASE_URL: base,
    });
    assert.equal(b.code, 4, `a corrupt ledger must refuse\nstdout:\n${b.out}`);
    assert.equal(state.posts, 0, 'refusals must never reach the network');
  } finally {
    server.close();
  }
});

test('guard: clean root creates exactly once, then a second run resumes with zero new requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zgci-guard-create-'));
  const { server, state } = mockHub();
  const base = await listen(server);
  const env = {
    SYNTHMEDIA_OUTPUT_DIR: root,
    SYNTHMEDIA_ZGCI_API_KEY: 'dummy-key-not-real',
    SYNTHMEDIA_ZGCI_BASE_URL: base,
    SYNTHMEDIA_ZGCI_POLL_MS: '20',
  };
  try {
    const first = await runValidate(env);
    assert.equal(first.code, 0, `first (authorized) run must succeed\nstdout:\n${first.out}\nstderr:\n${first.err}`);
    assert.match(first.out, /PREFLIGHT-CLEAR/);
    assert.equal(state.posts, 1, 'a clean root may create exactly one task');
    const ledger = JSON.parse(await readFile(join(root, 'zgci-real-runs.json'), 'utf8'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].remoteId, 'task_MOCKcreated0001');

    const second = await runValidate(env);
    assert.equal(second.code, 0, `second run must resume\nstdout:\n${second.out}`);
    assert.match(second.out, /RESUMED-QUERY-ONLY/);
    assert.equal(state.posts, 1, 'the second run must NOT create another task');
  } finally {
    server.close();
  }
});
