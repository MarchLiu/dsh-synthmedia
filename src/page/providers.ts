/**
 * Config-page data source: enumerate the providers/models declared in the DSH
 * profile configuration and classify each model into a synthmedia ecosystem.
 *
 * The DSH providers live in the profile's cordis.patch.yml user patch (e.g.
 * the `llm-pi-ai` row's `config.providers` map). Reading it is READ-ONLY and
 * confined to the single path supplied by the operator through the plugin
 * config field `providersPatchPath` — no other filesystem surface is opened.
 *
 * Classification is intentionally conservative: only two ecosystems are
 * supported today, everything else is reported as `unsupported` so the UI can
 * grey it out with「暂不支持」.
 * @module
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** synthmedia ecosystems the import flow can map onto. */
export type Ecosystem =
  | 'volcengine-seedance'
  | 'minimax-h3'
  | 'aliyun-wan'
  | 'google-gemini'
  | 'openai-media'
  | 'unsupported';

export interface DshModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly ecosystem: Ecosystem;
  /** synthmedia modality the model maps onto (only for supported ones). */
  readonly modality?: 'video' | 'image' | 'audio';
}

export interface DshProviderEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly baseURL?: string;
  readonly models: readonly DshModelEntry[];
}

/**
 * Classify one model id. Deliberately narrow: a bare `h3` or a provider name
 * like "ark-code-latest" must NOT classify as supported.
 *  - volcengine-seedance: seedance (video) / seedream (image) / seed-tts (audio)
 *  - minimax-h3: ids that mention minimax AND h3 (covers `minimax-h3` relay
 *    alias and the official `MiniMax-H3*` spellings).
 */
export function classifyModel(modelId: string): { ecosystem: Ecosystem; modality?: 'video' | 'image' | 'audio' } {
  const id = String(modelId);
  if (/seedance/i.test(id)) return { ecosystem: 'volcengine-seedance', modality: 'video' };
  if (/seedream/i.test(id)) return { ecosystem: 'volcengine-seedance', modality: 'image' };
  if (/seed[-_]?tts/i.test(id)) return { ecosystem: 'volcengine-seedance', modality: 'audio' };
  if (/minimax/i.test(id) && /h3/i.test(id)) return { ecosystem: 'minimax-h3', modality: 'video' };
  // aliyun-wan: wan2.x video (wan*-t2v) and wanx* image. A bare "wan" prefix
  // is NOT enough — require the t2v/t2i task suffix to avoid false positives.
  if (/^wan[\d.]*-t2v/i.test(id) || /^wan2[\d.]*-i2v/i.test(id)) return { ecosystem: 'aliyun-wan', modality: 'video' };
  if (/^wanx[\d.]*-t2i/i.test(id)) return { ecosystem: 'aliyun-wan', modality: 'image' };
  // google-gemini: Imagen image / Veo video / gemini image models.
  if (/^imagen-[\d.]/i.test(id)) return { ecosystem: 'google-gemini', modality: 'image' };
  if (/^veo-[\d.]/i.test(id)) return { ecosystem: 'google-gemini', modality: 'video' };
  // openai-media: gpt-image (image) / sora (video).
  // NOTE: the official OpenAI Sora Videos API was shut down on 2026-09-24;
  // this classification is kept only because third-party compatible gateways
  // may still expose sora-style model ids over the openai-video-compatible
  // protocol.
  if (/^gpt-image/i.test(id)) return { ecosystem: 'openai-media', modality: 'image' };
  if (/^sora-?\d/i.test(id)) return { ecosystem: 'openai-media', modality: 'video' };
  return { ecosystem: 'unsupported' };
}

/** One provider row inside a profile patch `config.providers` map. */
function readProviderRow(key: string, row: unknown): DshProviderEntry | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const rec = row as Record<string, unknown>;
  const rawModels = Array.isArray(rec['models']) ? rec['models'] : [];
  const models: DshModelEntry[] = [];
  for (const m of rawModels) {
    const id = m !== null && typeof m === 'object' && !Array.isArray(m) && typeof (m as Record<string, unknown>)['id'] === 'string'
      ? String((m as Record<string, unknown>)['id'])
      : typeof m === 'string'
        ? m
        : undefined;
    if (!id) continue;
    const name = m !== null && typeof m === 'object' && typeof (m as Record<string, unknown>)['name'] === 'string'
      ? String((m as Record<string, unknown>)['name'])
      : undefined;
    const { ecosystem, modality } = classifyModel(id);
    models.push(ecosystem === 'unsupported' ? { id, ecosystem } : { id, ...(name ? { name } : {}), ecosystem, modality });
  }
  return {
    id: key,
    ...(typeof rec['displayName'] === 'string' ? { displayName: rec['displayName'] } : {}),
    ...(typeof rec['baseURL'] === 'string' ? { baseURL: rec['baseURL'] } : {}),
    models,
  };
}

/**
 * Parse the YAML text of a profile cordis.patch.yml and return every provider
 * map found (rows whose `config.providers` is an object of provider rows).
 * Malformed rows are skipped, never thrown: the import UI must keep working
 * when the patch carries unrelated entries.
 */
export function parseDshProviders(yamlText: string): DshProviderEntry[] {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const out: DshProviderEntry[] = [];
  for (const row of doc) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const config = (row as Record<string, unknown>)['config'];
    if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
    const providers = (config as Record<string, unknown>)['providers'];
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue;
    for (const [key, prow] of Object.entries(providers as Record<string, unknown>)) {
      const entry = readProviderRow(key, prow);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** Read the providers patch from disk (read-only, single configured path). */
export function readDshProviders(path: string): DshProviderEntry[] {
  return parseDshProviders(readFileSync(path, 'utf8'));
}

// --- Import-panel media suggestions -----------------------------------------

/** Wire protocol → synthmedia ecosystem (the import panel's fallback mapping). */
export const PROTOCOL_ECOSYSTEM: Record<string, Exclude<Ecosystem, 'unsupported'>> = {
  'minimax-video-compatible': 'minimax-h3',
  'volcengine-ark-compatible': 'volcengine-seedance',
  'dashscope-wan-compatible': 'aliyun-wan',
  'google-genmedia-compatible': 'google-gemini',
  'openai-video-compatible': 'openai-media',
  'openai-images-compatible': 'openai-media',
};

/** Modality implied by an ecosystem when the matched preset carries none. */
export const ECOSYSTEM_DEFAULT_MODALITY: Record<string, 'video' | 'image' | 'audio'> = {
  'volcengine-seedance': 'video',
  'minimax-h3': 'video',
  'aliyun-wan': 'video',
  'google-gemini': 'video',
  'openai-media': 'video',
};

/** One import-panel suggestion: a model id plus the ecosystem it maps onto. */
export interface MediaSuggestion {
  readonly id: string;
  readonly ecosystem: Exclude<Ecosystem, 'unsupported'>;
  readonly modality: 'video' | 'image' | 'audio';
  /** Where the id came from: the provider's own list, a base-URL preset match, or a manual addition. */
  readonly source: 'provider' | 'preset' | 'manual';
}

const normBase = (url: unknown): string =>
  String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * Media-model suggestions for one DSH provider on the import panel.
 *
 * DSH providers declare LLM chat models, so their own `models` lists rarely
 * classify as media ecosystems. The panel therefore ALSO derives candidates
 * from the built-in ProviderProfile presets whose `baseUrl` equals the
 * provider's `baseURL` (e.g. hub.zgci.org → zgci-h3's `minimax-h3`,
 * llm.inner.bza.edu.cn → the bza Seedance/Seedream/SeedTTS series), plus any
 * manually added ids. Each candidate is classified by id first (classifyModel);
 * only ids that literally appear in a matched preset's model list may fall
 * back to that preset's wire protocol — unknown/LLM ids on a preset-matching
 * baseURL stay unsupported (greyed out「暂不支持」, never promoted to media).
 *
 * `builtins` is the minimal preset shape the client bakes (id, protocol,
 * baseUrl, models, modalities) — plain structural typing keeps the function
 * testable without importing the full config resolvers.
 */
export function suggestionsForProvider(
  provider: { readonly baseURL?: string; readonly models?: readonly (string | { readonly id: string })[] },
  builtins: ReadonlyArray<{
    readonly id: string;
    readonly protocol: string;
    readonly baseUrl: string;
    readonly models?: readonly string[];
    readonly modalities?: readonly string[];
  }>,
  manualIds: readonly string[] = [],
): MediaSuggestion[] {
  const providerBase = normBase(provider['baseURL']);
  const matched = builtins.filter((b) => providerBase !== '' && normBase(b.baseUrl) === providerBase);
  const ordered: Array<{ id: string; source: MediaSuggestion['source'] }> = [];
  const seen = new Set<string>();
  const push = (id: string, source: MediaSuggestion['source']) => {
    const clean = String(id ?? '').trim();
    if (clean === '' || seen.has(clean)) return;
    seen.add(clean);
    ordered.push({ id: clean, source });
  };
  for (const m of provider.models ?? []) push(typeof m === 'string' ? m : m.id, 'provider');
  for (const b of matched) for (const id of b.models ?? []) push(id, 'preset');
  for (const id of manualIds) push(id, 'manual');
  const out: MediaSuggestion[] = [];
  for (const { id, source } of ordered) {
    const byId = classifyModel(id);
    let ecosystem: Exclude<Ecosystem, 'unsupported'> | undefined =
      byId.ecosystem === 'unsupported' ? undefined : byId.ecosystem;
    let modality = byId.modality;
    if (ecosystem === undefined) {
      // Protocol fallback ONLY for ids that literally appear in a matched
      // preset's own model list. A bare baseURL match must NOT promote the
      // provider's unknown/LLM ids (glm-5.3, text-embedding-3-large,
      // deepseek-latest, kimi-k3.1-pro, …) into media models — they stay
      // unsupported so the UI greys them「暂不支持」.
      const preset = matched.find((b) => (b.models ?? []).includes(id));
      const mapped = preset === undefined ? undefined : PROTOCOL_ECOSYSTEM[preset.protocol];
      if (preset !== undefined && mapped !== undefined) {
        ecosystem = mapped;
        const first = (preset.modalities ?? [])[0];
        modality = first === 'image' || first === 'audio' ? first : ECOSYSTEM_DEFAULT_MODALITY[mapped];
      }
    }
    if (ecosystem === undefined) continue;
    out.push({ id, ecosystem, modality: modality ?? ECOSYSTEM_DEFAULT_MODALITY[ecosystem] ?? 'video', source });
  }
  return out;
}
