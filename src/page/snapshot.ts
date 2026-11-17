/**
 * Config-page server brain: effective-profile snapshot, provider import data,
 * system detection, download wiring and the `/synthmedia` command grammar.
 *
 * Kept free of cordis types so unit tests drive it with plain inputs; the
 * apply() wiring in src/index.ts only adapts ctx ↔ this module.
 * @module
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig, SynthMediaConfig } from '../config.js';
import { resolveConfig } from '../config.js';
import { parseCustomProfiles, mergeCustomBackends } from './custom.js';
import { readDshProviders, type DshProviderEntry } from './providers.js';
import { collectSystemReport, assessH3, DEFAULT_H3_THRESHOLDS, type SystemReport, type H3Assessment } from './system.js';
import { parseOrder, parseEnabledResources, parseEnabledTools, orderProfiles, resolveDefaultProfile, type ToolName } from './priority.js';
import { gateBackends, type EcosystemGate } from './ecosystems.js';
import { detectToolchain, type ToolStatus } from './toolchain.js';
import {
  DownloadManager,
  defaultManifest,
  readOptionalText,
  type DownloadProgress,
} from './downloads.js';
import { fetchRemoteModels, presetBaseUrls, type HostLookup } from './fetch-models.js';
import { classifyModel } from './providers.js';

/** Page-scoped knobs (subset of the plugin Config schema). */
export interface PageOptions {
  readonly dataDir: string;
  readonly providersPatchPath?: string;
}

export interface ProfileView {
  readonly id: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly modalities: readonly string[];
  /** Environment-variable NAME only — never a value. */
  readonly authEnv?: string;
  readonly online: boolean;
  readonly protocolVerified: boolean;
  readonly liveVerified: boolean;
  readonly blockRealSubmit: boolean;
  readonly source: 'preset' | 'custom' | 'custom-override';
  /** 1-based position in providerOrder (phase one; absent = unranked). */
  readonly priority?: number;
  /** True when this profile is the effective default for one of its modalities. */
  readonly effectiveDefault?: boolean;
  /** Ecosystem gate (phase one): h3 | seedance | other + supported flag. */
  readonly ecosystem?: string;
  readonly supported?: boolean;
  readonly ecosystemReason?: string;
}

export interface PageSnapshot {
  readonly profiles: readonly ProfileView[];
  readonly providers: readonly DshProviderEntry[];
  readonly providersError?: string;
  readonly downloads: readonly DownloadProgress[];
  readonly downloadManifest: { readonly downloadsDir: string; readonly entries: readonly unknown[] };
  readonly customProfilesError?: string;
  readonly dataDir: string;
  /** Phase-one additions (back-compat: extra fields only). */
  readonly order: readonly string[];
  readonly enabledDshResources: readonly string[];
  readonly enabledTools: readonly string[];
  readonly ecosystems: Readonly<Record<string, EcosystemGate>>;
  readonly tools?: readonly ToolStatus[];
  /** Parse warnings from the new JSON-array config fields (never thrown). */
  readonly configWarnings?: readonly string[];
}

/** Base backends map with the built-in defaults resolved. */
function baseBackends(options: Record<string, unknown>): Record<string, BackendConfig> {
  const resolved = resolveConfig(options);
  return { ...resolved.backends } as Record<string, BackendConfig>;
}

/**
 * Effective configuration = built-in presets + config backends overrides +
 * parsed customProfiles (validated; corrupt → ignored with diagnostics).
 */
export function effectiveConfig(
  config: Record<string, unknown>,
): { config: SynthMediaConfig; customError?: string } {
  const customRaw = config['customProfiles'];
  const { profiles, error } = parseCustomProfiles(customRaw);
  const base = baseBackends(config);
  // Profile-level config overrides (backends map) win over defaults; custom
  // profiles win over built-ins with the same id.
  const backends = mergeCustomBackends(base, profiles);
  const resolved = resolveConfig({ ...config, backends });
  return { config: resolved, ...(error ? { customError: error } : {}) };
}

function profileView(b: BackendConfig, customIds: ReadonlySet<string>): ProfileView {
  return {
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
    source: customIds.has(b.id) ? 'custom' : 'preset',
  };
}

/** Everything the config page (settings card + session tab) renders. */
export function buildSnapshot(
  config: Record<string, unknown>,
  options: PageOptions,
  extras: { readonly providers?: readonly DshProviderEntry[]; readonly providersError?: string; readonly downloads?: readonly DownloadProgress[]; readonly downloadManifest?: { downloadsDir: string; entries: readonly unknown[] }; readonly tools?: readonly ToolStatus[] } = {},
): PageSnapshot {
  const { config: resolved, customError } = effectiveConfig(config);
  const customIds = new Set(parseCustomProfiles(config['customProfiles']).profiles.map((p) => p.id));
  const { order, warnings: orderWarn } = parseOrder(config['providerOrder']);
  const { resources, warnings: resWarn } = parseEnabledResources(config['enabledDshResources']);
  const { tools: enabledTools, warnings: toolWarn } = parseEnabledTools(config['enabledTools']);
  const warnings = [...orderWarn, ...resWarn, ...toolWarn];
  const gates = gateBackends(resolved.backends);
  const backendList = Object.values(resolved.backends);
  const defaults = new Set<string>();
  const modalities = new Set<string>();
  for (const b of backendList) for (const m of b.modalities) modalities.add(m);
  for (const m of modalities) {
    const d = resolveDefaultProfile(backendList, m, order, (p) => gates[p.id]?.supported === true);
    if (d) defaults.add(d.id);
  }
  const priorityOf = (id: string): number | undefined => {
    const i = order.indexOf(id);
    return i >= 0 ? i + 1 : undefined;
  };
  const profiles = orderProfiles(backendList, order).map((b) => {
    const gate = gates[b.id];
    const prio = priorityOf(b.id);
    return {
      ...profileView(b, customIds),
      ...(prio !== undefined ? { priority: prio } : {}),
      ...(defaults.has(b.id) ? { effectiveDefault: true } : {}),
      ...(gate ? { ecosystem: gate.ecosystem, supported: gate.supported, ...(gate.reason ? { ecosystemReason: gate.reason } : {}) } : {}),
    };
  });
  return {
    profiles,
    providers: extras.providers ?? [],
    ...(extras.providersError ? { providersError: extras.providersError } : {}),
    downloads: extras.downloads ?? [],
    downloadManifest: extras.downloadManifest ?? { downloadsDir: join(options.dataDir, 'downloads'), entries: [] },
    ...(customError ? { customProfilesError: customError } : {}),
    ...(warnings.length > 0 ? { configWarnings: warnings } : {}),
    dataDir: options.dataDir,
    order,
    enabledDshResources: resources,
    enabledTools,
    ecosystems: gates,
    ...(extras.tools ? { tools: extras.tools } : {}),
  };
}

/** Read providers from the configured patch path (safe: read-only, one file). */
export function loadProviders(patchPath?: string): { providers: readonly DshProviderEntry[]; error?: string } {
  if (!patchPath) {
    return { providers: [], error: '未配置 providersPatchPath（指向 profile 的 cordis.patch.yml），无法枚举 DSH providers' };
  }
  try {
    return { providers: readDshProviders(patchPath) };
  } catch (err) {
    return { providers: [], error: `读取 providers 配置失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Minimal structural face of the JobManager the page commands use. */
export interface PageJobs {
  get(id: string): Promise<{
    id: string;
    artifacts: ReadonlyArray<{ path: string }>;
    owner?: string;
    ancestors?: readonly string[];
  } | undefined>;
  list(filter?: { owner?: string; session?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
  cancel(id: string): Promise<Record<string, unknown>>;
}

/**
 * Session-scope gate for one job record: a caller session sees its own jobs
 * and the jobs of the agents it spawned (their `ancestors` chain contains the
 * caller). An unscoped call (no caller identity — same-process tests, direct
 * module use) keeps the old behaviour. This is the authority for `cancel`,
 * `reveal` and the `owner` argument of `jobs`, so one conversation can never
 * read or stop another conversation's generation.
 */
function jobVisibleTo(
  job: { owner?: string; ancestors?: readonly string[] } | undefined,
  caller: string | undefined,
): boolean {
  if (caller === undefined) return true;
  if (job === undefined) return false;
  if (job.owner === caller) return true;
  return Array.isArray(job.ancestors) && job.ancestors.includes(caller);
}

/** Services the page command handlers run against. */
export interface PageServices {
  readonly manager: DownloadManager;
  readonly options: PageOptions;
  /** Live config captured from apply(); customProfiles parsed per call. */
  readonly config: Record<string, unknown>;
  /** Optional host credential resolver (env NAME → value, in memory only). */
  readonly resolveCredential?: (name: string) => Promise<string | undefined>;
  /** Optional DNS resolver for the fetch-models SSRF guard (tests inject it). */
  readonly lookup?: HostLookup;
  /** Optional toolchain probe (tests inject a scripted one; no process spawn). */
  readonly detectTools?: (enabled: readonly ToolName[]) => Promise<readonly ToolStatus[]>;
  /** Optional system-report collector (tests inject a stub; defaults to real probes). */
  readonly collectReport?: (dir: string) => Promise<SystemReport>;
  /** Optional JobManager face for `/synthmedia jobs` + `reveal`. */
  readonly jobs?: PageJobs;
  /** Absolute output root for the reveal fence (resolve(outputDir)). */
  readonly outputRoot?: () => string;
  /**
   * Reveal implementation (defaults to task-agent.revealArtifact with
   * process.platform). Tests inject a spy — never spawn in tests.
   */
  readonly reveal?: (filePath: string) => Promise<void>;
  /** Origin-absolute download route base when the host webserver is present. */
  downloadBase?: string;
}

export function createPageServices(
  config: Record<string, unknown>,
  options: PageOptions,
  hostJobs?: unknown,
  resolveCredential?: (name: string) => Promise<string | undefined>,
  jobs?: PageJobs,
  outputRoot?: () => string,
): PageServices {
  mkdirSync(options.dataDir, { recursive: true });
  const downloadsDir = join(options.dataDir, 'downloads');
  const { config: resolved } = effectiveConfig(config);
  const manifest = defaultManifest(downloadsDir);
  const manager = new DownloadManager(manifest, undefined, hostJobs as never);
  // Load the operator-edited manifest (falls back to defaults, never throws).
  void manager.loadManifest(join(options.dataDir, 'downloads.json'));
  void resolved;
  return {
    manager,
    options,
    config,
    ...(resolveCredential ? { resolveCredential } : {}),
    ...(jobs ? { jobs } : {}),
    ...(outputRoot ? { outputRoot } : {}),
  };
}

export async function pageDetect(services: PageServices): Promise<{ report: SystemReport; assessment: H3Assessment }> {
  // statfs needs an existing path: probe the data dir (downloads live below
  // it and share the same volume, so free-disk is identical).
  const targetDir = services.options.dataDir;
  const collect = services.collectReport ?? collectSystemReport;
  const report = await collect(targetDir);
  return { report, assessment: assessH3(report, DEFAULT_H3_THRESHOLDS) };
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

/** Human text for the /synthmedia command. */
export function renderText(services: PageServices, providers: readonly DshProviderEntry[], providersError?: string): string {
  const { config: resolved, customError } = effectiveConfig(services.config);
  const customIds = new Set(parseCustomProfiles(services.config['customProfiles']).profiles.map((p) => p.id));
  const lines: string[] = ['SynthMedia ProviderProfile 一览（密钥仅显示环境变量名，永不显示值）：'];
  for (const b of Object.values(resolved.backends)) {
    const v = profileView(b, customIds);
    lines.push(
      `- ${v.id} [${v.source}] protocol=${v.protocol} baseURL=${v.baseUrl} models=[${v.models.join(', ')}]` +
      ` authEnv=${v.authEnv ?? '（无需凭据）'} verified=${v.protocolVerified ? '协议✓' : '协议✗'}/${v.liveVerified ? '实测✓' : '实测✗'}` +
      (v.blockRealSubmit ? '（已封锁真实提交）' : ''),
    );
  }
  if (customError) lines.push(`注意：${customError}`);
  if (providersError) {
    lines.push(`DSH providers 导入：${providersError}`);
  } else {
    lines.push(`DSH providers（${providers.length} 个）：火山 Seedance / MiniMax H3 / 阿里万相 / Gemini / OpenAI 生态可导入，其余暂不支持。`);
  }
  lines.push(`子命令：/synthmedia json | providers | detect | jobs [owner] | reveal <jobId> | fetch-models <baseURL> | dl list|start <id>|cancel <id>`);
  return lines.join('\n');
}

/**
 * `/synthmedia` subcommand execution. Returns { kind, text, json? } where
 * `json` carries the machine-readable payload the client tab renders.
 */
export async function runPageCommand(
  services: PageServices,
  rawInput: string,
  opts?: { caller?: string },
): Promise<{ kind: 'success' | 'error'; text: string; json?: unknown }> {
  const caller = typeof opts?.caller === 'string' && opts.caller.length > 0 ? opts.caller : undefined;
  const input = rawInput.trim();
  const arg = input.toLowerCase();
  const providers = loadProviders(services.options.providersPatchPath);
  if (arg === '' || arg === 'status') {
    return { kind: 'success', text: renderText(services, providers.providers, providers.error) };
  }
  if (arg === 'json') {
    const providersData = loadProviders(services.options.providersPatchPath);
    const { tools: enabledTools } = parseEnabledTools(services.config['enabledTools']);
    const probe = services.detectTools ?? detectToolchain;
    const tools = await probe(enabledTools);
    const snapshot = buildSnapshot(services.config, services.options, {
      providers: providersData.providers,
      ...(providersData.error ? { providersError: providersData.error } : {}),
      downloads: services.manager.list(),
      downloadManifest: {
        downloadsDir: services.manager.manifestNow().downloadsDir,
        entries: services.manager.manifestNow().entries,
      },
      tools,
    });
    return { kind: 'success', text: 'synthmedia 配置页快照已生成', json: snapshot };
  }
  if (arg === 'providers') {
    if (providers.error) return { kind: 'success', text: `DSH providers：${providers.error}` };
    const lines = providers.providers.map((p) => {
      const models = p.models.map((m) => `${m.id}${m.ecosystem === 'unsupported' ? '（暂不支持）' : `（${m.ecosystem}）`}`).join(', ');
      return `- ${p.displayName ?? p.id} ${p.baseURL ?? ''}: ${models}`;
    });
    return { kind: 'success', text: lines.length > 0 ? lines.join('\n') : '未在 providers 配置中发现任何 provider' };
  }
  if (arg === 'detect') {
    try {
      const { report, assessment } = await pageDetect(services);
      // Toolchain + ecosystem summary: `/synthmedia detect` is the operator's
      // one-stop check before wiring an offline H3 service (enabled tools are
      // probed, disabled ones are not spawned; unknown config degrades).
      const { tools: enabledTools } = parseEnabledTools(services.config['enabledTools']);
      const probe = services.detectTools ?? detectToolchain;
      const tools = await probe(enabledTools);
      const { config: resolved } = effectiveConfig(services.config);
      const ecosystems = gateBackends(resolved.backends);
      const countEco = (id: string): number => Object.values(ecosystems).filter((g) => g.ecosystem === id).length;
      const toolLine = tools.length === 0
        ? '工具链：未启用（Config 页勾选 ffmpeg / imagemagick / gimp / blender 后显示探测结果）'
        : `工具链：${tools.map((t) => `${t.name}${t.enabled ? (t.installed ? '✓' : '✗') : '(未启用)'}`).join(' ')}`;
      const lines = [
        `平台 ${report.platform}/${report.arch} · CPU ${report.cpuCount} 核 ${report.cpuModel ?? ''}`,
        report.totalMemBytes !== undefined ? `内存 ${fmtBytes(report.totalMemBytes)}` : '内存未知',
        report.freeDiskBytes !== undefined ? `目标目录可用磁盘 ${fmtBytes(report.freeDiskBytes)}` : '磁盘未知',
        report.gpuInfo ?? 'GPU 信息不可用',
        `运行时：python=${report.runtimes.python ?? '未找到'} uv=${report.runtimes.uv ?? '未找到'} node=${report.runtimes.node ?? '未找到'}`,
        '',
        `离线 H3 可行性：${assessment.overall}`,
        ...assessment.dimensions.map((d) => `- ${d.dimension}：${d.value} → ${d.verdict}（${d.basis}）`),
        '',
        toolLine,
        `生态门禁：h3 ${countEco('h3')} · seedance ${countEco('seedance')} · other ${countEco('other')}（other 不参与默认路由，仍可显式调用）`,
      ];
      return {
        kind: 'success',
        text: lines.join('\n'),
        json: { report, assessment, tools, ecosystems },
      };
    } catch (err) {
      return { kind: 'error', text: `检测失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (arg.startsWith('cancel ')) {
    // Cancel one running job from the sidebar / command face (the same
    // cooperative cancellation the synthmedia_cancel tool performs).
    const parts = input.split(/\s+/);
    const jobId = parts[1];
    if (!jobId) return { kind: 'error', text: '用法：/synthmedia cancel <jobId>' };
    if (!services.jobs) return { kind: 'error', text: '取消不可用：此命令需要 JobManager（插件宿主半提供）。' };
    try {
      const existing = await services.jobs.get(jobId);
      if (!existing) return { kind: 'error', text: `任务 ${jobId} 不存在。` };
      if (!jobVisibleTo(existing, caller)) return { kind: 'error', text: '无权操作其它会话的生成任务。' };
      const record = await services.jobs.cancel(jobId);
      return { kind: 'success', text: `已请求取消：${jobId}`, json: record };
    } catch (err) {
      return { kind: 'error', text: `取消失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (arg === 'jobs' || arg.startsWith('jobs ')) {
    // Sub-task list: running first, then recent finished; optional owner
    // filter (the calling agent session id) shapes the per-session view.
    if (!services.jobs) return { kind: 'error', text: '任务列表不可用：此命令需要 JobManager（插件宿主半提供）。' };
    // `jobs [--limit N] [owner]`: the panel pages through an old conversation's
    // history with --limit (records are never pruned), 50 by default, 200 max.
    const parts = input.split(/\s+/);
    let requestedOwner: string | undefined;
    let limit = 50;
    for (let i = 1; i < parts.length; i += 1) {
      const token = parts[i];
      if (token === '--limit' || token === '-n') {
        const value = Number(parts[i + 1]);
        if (Number.isFinite(value) && value > 0) limit = Math.min(Math.floor(value), 200);
        i += 1;
        continue;
      }
      if (requestedOwner === undefined && !token.startsWith('-')) requestedOwner = token;
    }
    // Default scope is the CALLER'S SESSION TREE (its own jobs + the jobs of
    // the agents it spawned). An explicit owner argument is honored only for
    // the caller itself: one conversation must not enumerate another's jobs.
    if (requestedOwner !== undefined && caller !== undefined && requestedOwner !== caller) {
      return { kind: 'error', text: '只能查看本会话（含其子代理）的生成任务。' };
    }
    const listFilter = requestedOwner !== undefined && caller === undefined
      ? { owner: requestedOwner, limit }
      : caller !== undefined
        ? { session: caller, limit }
        : { limit };
    const jobs = await services.jobs.list(listFilter);
    const lines = jobs.map((j) => {
      const r = j as Record<string, unknown>;
      const arts = Array.isArray(r['artifacts']) ? r['artifacts'] as Array<Record<string, unknown>> : [];
      return `- ${r['id']} [${r['status']}] ${r['progress'] ?? 0}% ${r['backend']}/${r['model']} (${r['modality']})` +
        ` owner=${typeof r['owner'] === 'string' ? r['owner'] : '—'}` +
        (arts.length > 0 ? ` artifacts=${arts.map((a) => a['path']).join(', ')}` : '') +
        (r['error'] && typeof r['error'] === 'object' ? ` error=[${(r['error'] as Record<string, unknown>)['code']}]` : '');
    });
    return {
      kind: 'success',
      text: lines.length > 0 ? `SynthMedia 任务（${jobs.length}，运行中优先）：\n${lines.join('\n')}` : '当前没有生成任务。',
      json: { jobs, ...(services.downloadBase ? { downloadBase: services.downloadBase } : {}) },
    };
  }
  if (arg.startsWith('reveal')) {
    // Open the containing folder of one job's artifact in the OS file manager.
    // Fenced to the output root; the platform dispatch spawns (no shell).
    const parts = input.split(/\s+/);
    const jobId = parts[1];
    if (!jobId) return { kind: 'error', text: '用法：/synthmedia reveal <jobId>' };
    if (!services.jobs || !services.outputRoot) return { kind: 'error', text: '打开目录不可用：此命令需要 JobManager（插件宿主半提供）。' };
    const job = await services.jobs.get(jobId);
    if (!job || !Array.isArray(job.artifacts) || job.artifacts.length === 0) {
      return { kind: 'error', text: `任务 ${jobId} 不存在或还没有产物。` };
    }
    if (!jobVisibleTo(job, caller)) return { kind: 'error', text: '无权操作其它会话的生成任务。' };
    const artifactPath = job.artifacts[0]?.path ?? '';
    const outputRoot = services.outputRoot();
    const { fenceArtifactPath, revealArtifact } = await import('../task-agent.js');
    const fenced = await fenceArtifactPath(outputRoot, jobId, artifactPath.split(/[\\/]/).pop() ?? '');
    if (!fenced) return { kind: 'error', text: '产物路径越界（必须位于 outputDir 内），已拒绝。' };
    try {
      const doReveal = services.reveal ?? ((p: string) => revealArtifact(outputRoot, jobId, p.split(/[\\/]/).pop() ?? ''));
      await doReveal(fenced);
      return { kind: 'success', text: `已在文件管理器中显示：${fenced}` };
    } catch (err) {
      return { kind: 'error', text: `打开目录失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (arg.startsWith('dl')) {
    const [, verb, id] = arg.split(/\s+/);
    try {
      if (!verb || verb === 'list') {
        const items = services.manager.list();
        if (items.length === 0) {
          const manifest = services.manager.manifestNow();
          return {
            kind: 'success',
            text: `下载清单（${manifest.downloadsDir}）：\n` + manifest.entries.map((e) => {
              const entry = e as { id: string; url: string; name: string };
              return `- ${entry.id} ${entry.name}${entry.url ? '' : '（URL 待填）'}`;
            }).join('\n'),
          };
        }
        return {
          kind: 'success',
          text: items.map((d) => {
            const pct = d.percent !== undefined ? `${d.percent}%` : '';
            const speed = d.speedBps !== undefined ? ` ${(d.speedBps / 1024 / 1024).toFixed(1)} MiB/s` : '';
            const eta = d.etaSeconds !== undefined ? ` 剩余 ${d.etaSeconds}s` : '';
            return `- ${d.id} [${d.status}] ${pct}${speed}${eta}${d.error ? ` — ${d.error}` : ''}`;
          }).join('\n'),
          json: items,
        };
      }
      if (verb === 'start') {
        if (!id) return { kind: 'error', text: '用法：/synthmedia dl start <清单id>' };
        const rec = await services.manager.start(id);
        return { kind: 'success', text: `下载已启动：${id}（宿主 Jobs UI 同步可见，kind=synthmedia-download）`, json: rec };
      }
      if (verb === 'cancel') {
        if (!id) return { kind: 'error', text: '用法：/synthmedia dl cancel <id>' };
        await services.manager.cancel(id);
        return { kind: 'success', text: `已请求取消：${id}` };
      }
      return { kind: 'error', text: '用法：/synthmedia dl list | start <id> | cancel <id>' };
    } catch (err) {
      return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    }
  }
  if (arg === 'fetch-models' || arg.startsWith('fetch-models ')) {
    // Server-side read-only model-list fetch (CORS bypass). Grammar:
    //   /synthmedia fetch-models <baseURL> [--token <pasted>] [--auth-env <NAME>]
    // Parse the ORIGINAL input: URLs, env-var names and Bearer tokens are
    // case-sensitive; only the command verb is case-insensitive.
    // The token/env VALUE is used in-memory for the single request only and
    // never appears in the response; the response carries model ids (+ names).
    const parts = input.split(/\s+/);
    const positional = parts.filter((p) => !p.startsWith('--')).slice(1);
    const flag = (name: string): string | undefined => {
      const i = parts.indexOf('--' + name);
      return i >= 0 && parts[i + 1] !== undefined ? parts[i + 1] : undefined;
    };
    const baseURL = positional[0];
    if (!baseURL) return { kind: 'error', text: '用法：/synthmedia fetch-models <providerBaseURL> [--token <值>] [--auth-env <环境变量名>]' };
    const answer = await fetchRemoteModels(baseURL, {
      allowedPresetBases: presetBaseUrls(services.config),
      token: flag('token'),
      authEnv: flag('auth-env'),
      resolveCredential: services.resolveCredential,
      ...(services.lookup ? { lookup: services.lookup } : {}),
    });
    if (!answer.ok) return { kind: 'error', text: `模型拉取失败：${answer.reason}` };
    const lines = answer.models.map((m) => {
      const { ecosystem, modality } = classifyModel(m.id);
      const tag = ecosystem === 'unsupported' ? '（暂不支持）' : `（${ecosystem}${modality ? ' · ' + modality : ''}）`;
      return `- ${m.id}${m.name !== undefined ? ` — ${m.name}` : ''} ${tag}`;
    });
    return {
      kind: 'success',
      text: `已拉取 ${answer.models.length} 个模型（${baseURL}）：\n${lines.join('\n')}\n凭据值不回显，仅本次请求在内存中使用。`,
      json: { models: answer.models.map((m) => m.id) },
    };
  }
  return {
    kind: 'error',
    text: '未知子命令。可用：/synthmedia [status] | json | providers | detect | jobs [owner] | reveal <jobId> | cancel <jobId> | fetch-models <baseURL> | dl list|start <id>|cancel <id>',
  };
}

export { readOptionalText };
