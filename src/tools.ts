/**
 * DSH tool registrations: synthmedia_capabilities / generate / status / wait /
 * cancel. Tool output is canonical structured JSON; every failure path carries
 * sanitized structured errors. No credential values can appear in any output.
 * @module
 */
import type { HostJobOwner, JobManager } from './jobs.js';
import { SynthError, sanitizeUnknown } from './errors.js';

/**
 * Structural subset of the DSH tool execution context used here. `agent` is
 * the initiating Agent (its `id` is the owner session the host jobs registry
 * fences access by); `callId` / `rootCallId` identify the creating call.
 */
interface ToolExec {
  signal: AbortSignal;
  agent?: { id?: string };
  callId?: string;
  rootCallId?: string;
}

/** Owner identity handed to the host jobs registry (only when truly known). */
function hostOwnerOf(exec: ToolExec | undefined): HostJobOwner | undefined {
  const owner = typeof exec?.agent?.id === 'string' && exec.agent.id.length > 0 ? exec.agent.id : undefined;
  const callId = typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined;
  const rootCallId = typeof exec?.rootCallId === 'string' && exec.rootCallId.length > 0
    ? exec.rootCallId
    : callId;
  if (!owner && !callId) return undefined;
  return {
    ...(owner ? { owner } : {}),
    ...(callId ? { toolCall: { callId, rootCallId: rootCallId! } } : {}),
  };
}

const modalityEnum = { type: 'string', enum: ['video', 'text', 'image', 'audio'] } as const;

function strSchema(desc: string): unknown {
  return { type: 'string', description: desc };
}

function jobOutputSchema(): unknown {
  return {
    type: 'object',
    properties: {
      job: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          backend: { type: 'string' },
          model: { type: 'string' },
          modality: modalityEnum,
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'] },
          progress: { type: 'number' },
          remoteId: { type: 'string' },
          createdAt: { type: 'string' },
          remoteCompletedAt: { type: 'string', description: 'provider-reported terminal time (never local)' },
          downloadedAt: { type: 'string', description: 'local time the artifact download finished' },
          finishedAt: { type: 'string', description: 'local time the job settled' },
          artifacts: { type: 'array', items: { type: 'object' } },
          error: { type: 'object' },
        },
        required: ['id', 'backend', 'status', 'progress'],
      },
    },
    required: ['job'],
  };
}

function renderJob(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const job = (value as { job: Record<string, unknown> }).job;
  const lines = [
    `job ${job['id']} — ${job['backend']}/${job['model']} (${job['modality']})`,
    `status: ${job['status']}  progress: ${job['progress']}%`,
  ];
  if (Array.isArray(job['artifacts']) && job['artifacts'].length > 0) {
    for (const a of job['artifacts'] as Array<Record<string, unknown>>) {
      lines.push(`artifact: ${a['path']} (${a['kind']}, ${a['bytes'] ?? '?'} bytes)`);
    }
  }
  if (job['error']) {
    const e = job['error'] as Record<string, unknown>;
    lines.push(`error: [${e['code']}] ${e['message']}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/** Wrap a tool body so any thrown value becomes a sanitized structured error. */
async function safeRun<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    const s = sanitizeUnknown(err, 'router');
    throw new SynthError(s.code, s.message, s.backend, s.retriable);
  }
}

export function buildSynthMediaTools(jobs: JobManager): Array<{
  name: string;
  description: string;
  parameters: unknown;
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> };
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>;
}> {
  const asArgs = (raw: unknown): Record<string, unknown> => (raw ?? {}) as Record<string, unknown>;

  return [
    {
      name: 'synthmedia_capabilities',
      description: 'List configured SynthMedia generation backends with modality, model and online/offline flags.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            backends: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, protocol: { type: 'string' }, modalities: { type: 'array', items: { type: 'string' } }, models: { type: 'array', items: { type: 'string' } }, modelCapabilities: { type: 'object' }, online: { type: 'boolean' }, protocolVerified: { type: 'boolean' }, realSubmitAllowed: { type: 'boolean' } } } },
          },
          required: ['backends'],
        },
        render: (_a, value) => {
          const list = (value as { backends: Array<Record<string, unknown>> }).backends;
          const lines = list.map((b) => {
            const mods = Array.isArray(b['modalities']) ? (b['modalities'] as string[]).join(',') : '';
            const models = Array.isArray(b['models']) ? (b['models'] as string[]).join(',') : '';
            const flag = b['online'] ? 'online' : 'offline/local';
            const verified = b['protocolVerified'] === true ? 'protocol-verified' : 'protocol-UNVERIFIED';
            const submit = b['realSubmitAllowed'] === false ? ' real-submit:BLOCKED' : '';
            const protocol = typeof b['protocol'] === 'string' ? ` ${b['protocol']}` : '';
            return `- ${b['id']}${protocol}: ${models} [${mods}] ${flag} ${verified}${submit}`;
          });
          return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'no backends configured' }];
        },
      },
      async execute() {
        return { backends: jobs.listBackends() };
      },
    },
    {
      name: 'synthmedia_generate',
      description: 'Submit an async generation job to an exact backend (no automatic fallback; offline backends fail hard if unreachable). Returns the job id.',
      parameters: {
        type: 'object',
        properties: {
          backend: strSchema('exact backend id from synthmedia_capabilities'),
          model: strSchema('model id served by the backend, as reported by synthmedia_capabilities'),
          modality: { ...modalityEnum, description: 'generation modality' },
          prompt: strSchema('generation prompt'),
          negativePrompt: strSchema('optional negative prompt (task-api backends only)'),
          durationSeconds: { type: 'number', description: 'video duration in seconds (clamped by backend)' },
          size: strSchema('video size "WxH", e.g. 1280x720'),
          seed: { type: 'number', description: 'random seed for reproducibility' },
        },
        required: ['backend', 'model', 'modality', 'prompt'],
      },
      output: { schema: jobOutputSchema(), render: renderJob },
      async execute(args, exec) {
        const a = asArgs(args);
        return safeRun(async () => {
          const record = await jobs.start({
            backend: String(a['backend']),
            model: String(a['model']),
            modality: a['modality'] as 'video' | 'text' | 'image' | 'audio',
            prompt: String(a['prompt'] ?? ''),
            negativePrompt: a['negativePrompt'] as string | undefined,
            durationSeconds: a['durationSeconds'] as number | undefined,
            size: a['size'] as string | undefined,
            seed: a['seed'] as number | undefined,
          }, hostOwnerOf(exec));
          exec.signal.addEventListener('abort', () => { void jobs.cancel(record.id); }, { once: true });
          return { job: record };
        });
      },
    },
    {
      name: 'synthmedia_status',
      description: 'Read the current status and progress of one SynthMedia job.',
      parameters: { type: 'object', properties: { id: strSchema('job id') }, required: ['id'] },
      output: { schema: jobOutputSchema(), render: renderJob },
      async execute(args) {
        const a = asArgs(args);
        return safeRun(async () => {
          const record = await jobs.get(String(a['id']));
          if (!record) throw new SynthError('E_NO_JOB', `unknown job id '${String(a['id'])}'`, 'router');
          return { job: record };
        });
      },
    },
    {
      name: 'synthmedia_wait',
      description: 'Wait until a SynthMedia job finishes and return its final record (artifacts ready on disk).',
      parameters: {
        type: 'object',
        properties: { id: strSchema('job id') },
        required: ['id'],
      },
      output: { schema: jobOutputSchema(), render: renderJob },
      async execute(args, exec) {
        const a = asArgs(args);
        return safeRun(async () => {
          const record = await jobs.wait(String(a['id']), exec.signal);
          return { job: record };
        });
      },
    },
    {
      name: 'synthmedia_cancel',
      description: 'Cancel one running SynthMedia job (cooperative: signals the local request and best-effort cancels the remote task).',
      parameters: { type: 'object', properties: { id: strSchema('job id') }, required: ['id'] },
      output: { schema: jobOutputSchema(), render: renderJob },
      async execute(args, exec) {
        const a = asArgs(args);
        return safeRun(async () => ({ job: await jobs.cancel(String(a['id']), exec.signal) }));
      },
    },
  ];
}
