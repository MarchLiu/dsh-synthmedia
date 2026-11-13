import { type ToolName } from './priority.js';
export interface ToolchainProbes {
    /** Locate a binary; undefined when not found (like `which`). */
    which(name: string): Promise<string | undefined>;
    /** Run `<name> <args…>`; undefined on error / non-zero exit / timeout. */
    version(name: string, args: readonly string[]): Promise<string | undefined>;
    /** Platform id for installHint selection (defaults to process.platform). */
    platform?(): string;
}
export interface ToolStatus {
    readonly name: ToolName;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly path?: string;
    readonly version?: string;
    readonly installHint: string;
    /** True when a probe ran but produced no readable result (degraded). */
    readonly unknownData?: boolean;
}
/**
 * Detect the four tools. `enabled` is the parsed `enabledTools` list — a
 * tool not in it is reported enabled:false and is NOT probed (zero side
 * effects for tools the operator did not opt into). Pass `enabled` as the
 * full TOOL_NAMES list to probe everything regardless of config.
 */
export declare function detectToolchain(enabled: readonly string[], probes?: ToolchainProbes): Promise<ToolStatus[]>;
