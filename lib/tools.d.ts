/**
 * DSH tool registrations: synthmedia_capabilities / generate / status / wait /
 * cancel. Tool output is canonical structured JSON; every failure path carries
 * sanitized structured errors. No credential values can appear in any output.
 * @module
 */
import type { JobManager } from './jobs.js';
import type { ToolStatus } from './page/toolchain.js';
import type { EcosystemGate } from './page/ecosystems.js';
/**
 * Structural subset of the DSH tool execution context used here. `agent` is
 * the initiating Agent (its `id` is the owner session the host jobs registry
 * fences access by); `callId` / `rootCallId` identify the creating call.
 */
interface ToolExec {
    signal: AbortSignal;
    agent?: {
        id?: string;
    };
    callId?: string;
    rootCallId?: string;
}
/**
 * Optional capabilities enrichment (phase-one routing surface). All maps are
 * computed by the CALLER at call time from the live config — this module
 * stays free of config imports. Existing output fields keep their meaning;
 * the new fields are pure additions.
 */
export interface CapabilitiesExtras {
    /** backend id → 1-based priority (position in providerOrder). Absent = unranked. */
    readonly priority?: Readonly<Record<string, number>>;
    /** backend ids that are the effective default for at least one modality. */
    readonly effectiveDefault?: ReadonlySet<string>;
    /** backend id → ecosystem gate (ecosystem / supported / reason). */
    readonly ecosystem?: Readonly<Record<string, EcosystemGate>>;
    /** Local toolchain statuses for the `tools` section. */
    readonly tools?: () => Promise<readonly ToolStatus[]>;
}
export declare function buildSynthMediaTools(jobs: JobManager, extras?: CapabilitiesExtras): Array<{
    name: string;
    description: string;
    parameters: unknown;
    output: {
        schema: unknown;
        render: (args: unknown, value: unknown) => Array<{
            type: 'text';
            text: string;
        }>;
    };
    execute: (args: unknown, exec: ToolExec) => Promise<unknown>;
}>;
export {};
