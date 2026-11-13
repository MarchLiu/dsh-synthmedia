/**
 * Config-page system resource detection + offline-H3 feasibility assessment.
 *
 * Detection uses ONLY process-local APIs (node:os, node:fs statfs) and a
 * small fixed set of read-only probe commands (sysctl/which/-v) executed with
 * fixed arguments and a hard timeout — no user-supplied input ever reaches a
 * shell. Every probe is best-effort: a failed probe degrades that single
 * field to `undefined` and the assessment says so.
 *
 * THRESHOLD SOURCES (see README「资源检测阈值」for the full table):
 *  - 73 GiB unified memory for 4-bit MiniMax H3: task-provided figure
 *    (operator knowledge of the H3 local deployment), not a published spec.
 *  - 48 GiB "勉强" floor: ESTIMATE (~2/3 of the full need; quantized cache
 *    offload assumed), explicitly an approximation.
 *  - 45 GiB model files on disk / 80 GiB comfortable: ESTIMATE for a 4-bit
 *    weight bundle plus runtime overhead.
 *  - 8 CPU cores comfortable floor: ESTIMATE for a sidecar serving one stream.
 * @module
 */
import { osProbes } from './system-probes.js';
export type Verdict = '充足' | '勉强' | '不足';
export interface SystemReport {
    readonly platform: string;
    readonly arch: string;
    readonly cpuCount: number;
    readonly cpuModel?: string;
    readonly totalMemBytes?: number;
    readonly freeDiskBytes?: number;
    readonly appleSilicon: boolean;
    readonly gpuInfo?: string;
    readonly runtimes: Readonly<Record<'python' | 'uv' | 'node', string | undefined>>;
}
export interface H3Thresholds {
    /** Unified memory (bytes) the 4-bit H3 deployment needs (task figure). */
    readonly memFullBytes: number;
    /** Memory floor below which the verdict is 不足 (ESTIMATE). */
    readonly memMinBytes: number;
    /** Disk the model files need (ESTIMATE). */
    readonly diskNeededBytes: number;
    /** Disk for a comfortable verdict (ESTIMATE). */
    readonly diskComfortBytes: number;
    /** CPU core count for a comfortable verdict (ESTIMATE). */
    readonly coresComfort: number;
    /** CPU core floor below which the verdict is 不足 (ESTIMATE). */
    readonly coresMin: number;
}
/** Default thresholds, byte-exact, with their provenance documented above. */
export declare const DEFAULT_H3_THRESHOLDS: H3Thresholds;
export interface DimensionAssessment {
    readonly dimension: string;
    readonly value: string;
    readonly verdict: Verdict;
    readonly basis: string;
    /** True when the underlying probe failed and the verdict is degraded. */
    readonly unknownData: boolean;
}
export interface H3Assessment {
    readonly overall: Verdict;
    readonly dimensions: readonly DimensionAssessment[];
}
/**
 * Pure threshold logic: map one measured byte/core value onto the three-tier
 * verdict. Exported for unit tests.
 */
export declare function assessDimension(dimension: string, value: number | undefined, min: number, comfort: number, basis: (v: number) => string): DimensionAssessment;
/** Assess the whole report against thresholds; overall = worst dimension. */
export declare function assessH3(report: SystemReport, thresholds?: H3Thresholds): H3Assessment;
/** Collect the report. `probes` is injectable for tests. */
export declare function collectSystemReport(targetDir: string, probes?: typeof osProbes): Promise<SystemReport>;
