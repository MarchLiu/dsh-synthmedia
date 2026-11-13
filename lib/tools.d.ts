/**
 * DSH tool registrations: synthmedia_capabilities / generate / status / wait /
 * cancel. Tool output is canonical structured JSON; every failure path carries
 * sanitized structured errors. No credential values can appear in any output.
 * @module
 */
import type { JobManager } from './jobs.js';
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
export declare function buildSynthMediaTools(jobs: JobManager): Array<{
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
