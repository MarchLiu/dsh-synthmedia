/**
 * Mock `apply()` smoke test: no network beyond a localhost stub, no credentials,
 * no real provider.
 *
 * Proves the host-facing wiring end to end:
 * - the jobs service is late-bound through `ctx.inject(['jobs'])` (not a
 *   direct `ctx.jobs` dereference) and `ctx.get('jobs')` is undefined at load;
 * - all five agent tools register;
 * - a generation job registers with the host registry as `kind:'synthmedia'`
 *   with the initiating session as `owner` and the creating tool call;
 * - progress is pushed, the host `done` settles as `completed`, the artifact is
 *   written to disk and the model-facing output carries it.
 *
 * Run: node scripts/mock-apply-smoke.mjs   (after `pnpm run build`)
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `echo:${payload.messages[0].content}` } }] }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const { apply } = await import('../lib/index.js');
const tools = new Map();
const hostSpecs = [];
const progress = [];
const hostDone = [];
const jobsMock = {
  start(spec) {
    const id = `host-${hostSpecs.length + 1}`;
    const handle = { id, append() {}, updateProgress(line) { progress.push(line); } };
    const hooks = spec.run(handle);
    hostSpecs.push({ spec, hooks });
    hooks.done.then((outcome) => hostDone.push(outcome));
    return id;
  },
};
let injected = false;
const ctx = {
  tools: { register: (def) => tools.set(def.name, def) },
  // The optional jobs service is absent at load time.
  get: () => undefined,
  // ...and arrives later through the cordis optional-dependency seam.
  inject: (deps, callback) => {
    // apply() late-binds TWO optional services these days ('jobs' and the
    // /synthmedia 'commands' seam); don't let the second call reset the flag.
    if (deps.includes('jobs')) injected = true;
    callback({ get: (name) => (name === 'jobs' ? jobsMock : undefined) });
  },
};
const outputDir = await mkdtemp(join(tmpdir(), 'synthmedia-smoke-'));
apply(ctx, {
  outputDir,
  backends: {
    'smoke-text': {
      protocol: 'openai-chat-compatible',
      model: 'smoke-1',
      models: ['smoke-1'],
      modalities: ['text'],
      baseUrl: base,
      authStyle: 'none',
      online: true,
      protocolVerified: true,
      timeoutMs: 5000,
      pollIntervalMs: 10,
    },
  },
});
const exec = {
  signal: new AbortController().signal,
  agent: { id: 'sess-smoke-1' },
  callId: 'call-77',
  rootCallId: 'root-77',
};
const generated = await tools.get('synthmedia_generate').execute(
  { backend: 'smoke-text', model: 'smoke-1', modality: 'text', prompt: 'hello' },
  exec,
);
const waited = await tools.get('synthmedia_wait').execute({ id: generated.job.id }, exec);
const artifact = waited.job.artifacts[0];
const content = await readFile(artifact.path, 'utf8');
await new Promise((resolve) => setTimeout(resolve, 20));

const result = {
  injected,
  toolNames: [...tools.keys()],
  status: waited.job.status,
  artifact: artifact.path,
  content,
  hostOwner: hostSpecs[0]?.spec.owner,
  hostToolCall: hostSpecs[0]?.spec.toolCall,
  hostKind: hostSpecs[0]?.spec.kind,
  progress,
  hostDone,
};
console.log(JSON.stringify(result, null, 2));

const expectedTools = [
  'synthmedia_capabilities',
  'synthmedia_generate',
  'synthmedia_status',
  'synthmedia_wait',
  'synthmedia_cancel',
];
const failures = [];
if (!injected) failures.push('ctx.inject(["jobs"]) was not used');
if (JSON.stringify([...tools.keys()]) !== JSON.stringify(expectedTools)) failures.push('five tools not registered');
if (result.status !== 'succeeded') failures.push(`job status ${result.status}`);
if (result.content !== 'echo:hello') failures.push('artifact content mismatch');
if (result.hostOwner !== 'sess-smoke-1') failures.push('host owner not the initiating session');
if (result.hostToolCall?.callId !== 'call-77' || result.hostToolCall?.rootCallId !== 'root-77') failures.push('host toolCall missing');
if (result.hostKind !== 'synthmedia') failures.push('host kind mismatch');
if (!progress.some((line) => line.includes('submitted'))) failures.push('no progress pushed to the host');
if (hostDone[0]?.status !== 'completed') failures.push('host done did not settle completed');
server.close();
if (failures.length > 0) {
  console.error(`mock apply smoke FAILED: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.error('mock apply smoke: OK');
}
