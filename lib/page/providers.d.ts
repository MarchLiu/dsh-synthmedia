/** synthmedia ecosystems the import flow can map onto. */
export type Ecosystem = 'volcengine-seedance' | 'minimax-h3' | 'aliyun-wan' | 'google-gemini' | 'openai-media' | 'unsupported';
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
export declare function classifyModel(modelId: string): {
    ecosystem: Ecosystem;
    modality?: 'video' | 'image' | 'audio';
};
/**
 * Parse the YAML text of a profile cordis.patch.yml and return every provider
 * map found (rows whose `config.providers` is an object of provider rows).
 * Malformed rows are skipped, never thrown: the import UI must keep working
 * when the patch carries unrelated entries.
 */
export declare function parseDshProviders(yamlText: string): DshProviderEntry[];
/** Read the providers patch from disk (read-only, single configured path). */
export declare function readDshProviders(path: string): DshProviderEntry[];
/** Wire protocol → synthmedia ecosystem (the import panel's fallback mapping). */
export declare const PROTOCOL_ECOSYSTEM: Record<string, Exclude<Ecosystem, 'unsupported'>>;
/** Modality implied by an ecosystem when the matched preset carries none. */
export declare const ECOSYSTEM_DEFAULT_MODALITY: Record<string, 'video' | 'image' | 'audio'>;
/** One import-panel suggestion: a model id plus the ecosystem it maps onto. */
export interface MediaSuggestion {
    readonly id: string;
    readonly ecosystem: Exclude<Ecosystem, 'unsupported'>;
    readonly modality: 'video' | 'image' | 'audio';
    /** Where the id came from: the provider's own list, a base-URL preset match, or a manual addition. */
    readonly source: 'provider' | 'preset' | 'manual';
}
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
export declare function suggestionsForProvider(provider: {
    readonly baseURL?: string;
    readonly models?: readonly (string | {
        readonly id: string;
    })[];
}, builtins: ReadonlyArray<{
    readonly id: string;
    readonly protocol: string;
    readonly baseUrl: string;
    readonly models?: readonly string[];
    readonly modalities?: readonly string[];
}>, manualIds?: readonly string[]): MediaSuggestion[];
