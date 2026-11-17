import { SynthError, sanitizeText, sanitizeUnknown } from './errors.js';
/** Owner identity handed to the host jobs registry (only when truly known). */
function hostOwnerOf(exec, ancestorsOf) {
    const owner = typeof exec?.agent?.id === 'string' && exec.agent.id.length > 0 ? exec.agent.id : undefined;
    const callId = typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined;
    const rootCallId = typeof exec?.rootCallId === 'string' && exec.rootCallId.length > 0
        ? exec.rootCallId
        : callId;
    if (!owner && !callId)
        return undefined;
    // The session tree: the parent chain of the calling agent. Without the
    // resolver the one-level parentSession recorded on the session is still
    // enough to attribute the job to its direct parent.
    let ancestors = [];
    try {
        const resolved = ancestorsOf ? ancestorsOf(exec?.agent) : [];
        ancestors = Array.isArray(resolved) ? resolved : [];
    }
    catch {
        ancestors = [];
    }
    if (ancestors.length === 0 && owner) {
        const parent = exec?.agent?.session?.meta?.parentSession;
        if (typeof parent === 'string' && parent.length > 0 && parent !== owner)
            ancestors = [parent];
    }
    return {
        ...(owner ? { owner } : {}),
        ...(ancestors.length > 0 ? { ancestors: [...ancestors] } : {}),
        ...(callId ? { toolCall: { callId, rootCallId: rootCallId } } : {}),
    };
}
const modalityEnum = { type: 'string', enum: ['video', 'text', 'image', 'audio'] };
function strSchema(desc) {
    return { type: 'string', description: desc };
}
function jobOutputSchema() {
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
function renderJob(args, value) {
    const job = value.job;
    const lines = [
        `job ${job['id']} — ${job['backend']}/${job['model']} (${job['modality']})`,
        `status: ${job['status']}  progress: ${job['progress']}%`,
    ];
    if (Array.isArray(job['artifacts']) && job['artifacts'].length > 0) {
        for (const a of job['artifacts']) {
            lines.push(`artifact: ${a['path']} (${a['kind']}, ${a['bytes'] ?? '?'} bytes)`);
        }
    }
    if (job['error']) {
        const e = job['error'];
        lines.push(`error: [${e['code']}] ${e['message']}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
}
/** Wrap a tool body so any thrown value becomes a sanitized structured error. */
async function safeRun(body) {
    try {
        return await body();
    }
    catch (err) {
        const s = sanitizeUnknown(err, 'router');
        throw new SynthError(s.code, s.message, s.backend, s.retriable);
    }
}
export function buildSynthMediaTools(jobs, extras) {
    const asArgs = (raw) => (raw ?? {});
    const FRAME_MAX_BYTES = 8 * 1024 * 1024;
    const frameMimeByMagic = (b) => {
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
            return 'image/jpeg';
        if (b.length >= 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
            return 'image/png';
        if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP')
            return 'image/webp';
        return undefined;
    };
    /** Read one optional frame path into a data URI; throws structured errors. */
    async function readFrameImage(role, raw) {
        if (raw === undefined || raw === null || raw === '')
            return undefined;
        if (typeof raw !== 'string' || raw.length === 0) {
            throw new SynthError('E_REQUEST', `${role} must be a file path string`, 'router');
        }
        const { readFile, stat } = await import('node:fs/promises');
        const { resolve } = await import('node:path');
        const path = resolve(raw);
        const st = await stat(path).catch(() => { throw new SynthError('E_REQUEST', `${role}: file not readable: ${sanitizeText(raw)}`, 'router'); });
        if (!st.isFile())
            throw new SynthError('E_REQUEST', `${role}: not a regular file: ${sanitizeText(raw)}`, 'router');
        if (st.size > FRAME_MAX_BYTES)
            throw new SynthError('E_REQUEST', `${role}: image exceeds 8 MB (${st.size} bytes)`, 'router');
        const bytes = await readFile(path);
        const mime = frameMimeByMagic(bytes);
        if (!mime)
            throw new SynthError('E_REQUEST', `${role}: unsupported image format (need jpg/png/webp, checked by magic bytes)`, 'router');
        return { role, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    async function readFrameImages(first, last) {
        const images = [
            await readFrameImage('first_frame', first),
            await readFrameImage('last_frame', last),
        ].filter((x) => x !== undefined);
        return images.length > 0 ? images : undefined;
    }
    return [
        {
            name: 'synthmedia_capabilities',
            description: 'List configured SynthMedia generation backends with modality, model and online/offline flags.',
            parameters: { type: 'object', properties: {} },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        backends: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, protocol: { type: 'string' }, modalities: { type: 'array', items: { type: 'string' } }, models: { type: 'array', items: { type: 'string' } }, modelCapabilities: { type: 'object' }, online: { type: 'boolean' }, protocolVerified: { type: 'boolean' }, realSubmitAllowed: { type: 'boolean' }, priority: { type: 'number', description: '1-based position in providerOrder (absent = unranked)' }, effectiveDefault: { type: 'boolean', description: 'default profile for at least one modality under the priority routing' }, ecosystem: { type: 'string', description: 'ecosystem id from the ecosystem gate (one of the supported ecosystem ids, or other when unclassified)' }, supported: { type: 'boolean', description: 'ecosystem gate: false = not default-routable' }, ecosystemReason: { type: 'string' } } } },
                        tools: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, enabled: { type: 'boolean' }, installed: { type: 'boolean' }, path: { type: 'string' }, version: { type: 'string' }, installHint: { type: 'string' } } }, description: 'local toolchain detection (ffmpeg/imagemagick/gimp/blender)' },
                    },
                    required: ['backends'],
                },
                render: (_a, value) => {
                    const list = value.backends;
                    const lines = list.map((b) => {
                        const mods = Array.isArray(b['modalities']) ? b['modalities'].join(',') : '';
                        const models = Array.isArray(b['models']) ? b['models'].join(',') : '';
                        const flag = b['online'] ? 'online' : 'offline/local';
                        const verified = b['protocolVerified'] === true ? 'protocol-verified' : 'protocol-UNVERIFIED';
                        const submit = b['realSubmitAllowed'] === false ? ' real-submit:BLOCKED' : '';
                        const prio = typeof b['priority'] === 'number' ? ` #${b['priority']}` : '';
                        const dflt = b['effectiveDefault'] === true ? ' default:*' : '';
                        const eco = typeof b['ecosystem'] === 'string' ? ` eco:${b['ecosystem']}${b['supported'] === false ? '(unsupported)' : ''}` : '';
                        const protocol = typeof b['protocol'] === 'string' ? ` ${b['protocol']}` : '';
                        return `- ${b['id']}${protocol}: ${models} [${mods}] ${flag} ${verified}${submit}${prio}${dflt}${eco}`;
                    });
                    const tools = value.tools;
                    if (Array.isArray(tools) && tools.length > 0) {
                        lines.push('tools: ' + tools.map((t) => `${t['name']}${t['installed'] ? '✓' : '✗'}${t['enabled'] ? '' : '(disabled)'}`).join(' '));
                    }
                    return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'no backends configured' }];
                },
            },
            async execute() {
                const enriched = jobs.listBackends().map((b) => {
                    const prio = extras?.priority?.[b.id];
                    const gate = extras?.ecosystem?.[b.id];
                    return {
                        ...b,
                        ...(prio !== undefined ? { priority: prio } : {}),
                        ...(extras?.effectiveDefault?.has(b.id) ? { effectiveDefault: true } : {}),
                        ...(gate ? { ecosystem: gate.ecosystem, supported: gate.supported, ...(gate.reason ? { ecosystemReason: gate.reason } : {}) } : {}),
                    };
                });
                const tools = extras?.tools ? await extras.tools() : undefined;
                return { backends: enriched, ...(tools ? { tools } : {}) };
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
                    firstFrame: strSchema('optional first-frame image: absolute file path (jpg/png/webp, <=8 MB); inlined as a data URI; video backends only'),
                    lastFrame: strSchema('optional last-frame image: absolute file path (jpg/png/webp, <=8 MB); inlined as a data URI; video backends only'),
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
                        modality: a['modality'],
                        prompt: String(a['prompt'] ?? ''),
                        negativePrompt: a['negativePrompt'],
                        durationSeconds: a['durationSeconds'],
                        size: a['size'],
                        seed: a['seed'],
                        images: await readFrameImages(a['firstFrame'], a['lastFrame']),
                    }, hostOwnerOf(exec, extras?.ancestorsOf));
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
                    if (!record)
                        throw new SynthError('E_NO_JOB', `unknown job id '${String(a['id'])}'`, 'router');
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
//# sourceMappingURL=tools.js.map