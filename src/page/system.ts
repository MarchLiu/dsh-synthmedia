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
 *  - 40 GiB model files on disk / 480 GiB comfortable: MEASURED sizes
 *    (2026-11-13, HF/ModelScope file listings). 33 GiB is the smallest
 *    documented usable set (unsloth GGUF Q4: DiT 10.6 + text encoder 17.0 +
 *    two VAEs 5.4), so 40 GiB is the "can you run it at all" floor; the
 *    official BF16 trees are 133.8 GiB (FL2VA) and 464.2 GiB (whole repo),
 *    so 480 GiB means "full repo without thinking about it".
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
  /** Disk the smallest usable checkpoint tree needs (measured FL2VA + margin). */
  readonly diskNeededBytes: number;
  /** Disk for the whole repo without thinking about it (measured + margin). */
  readonly diskComfortBytes: number;
  /** CPU core count for a comfortable verdict (ESTIMATE). */
  readonly coresComfort: number;
  /** CPU core floor below which the verdict is 不足 (ESTIMATE). */
  readonly coresMin: number;
}

/** Default thresholds, byte-exact, with their provenance documented above. */
export const DEFAULT_H3_THRESHOLDS: H3Thresholds = {
  memFullBytes: 73 * 1024 ** 3,
  memMinBytes: 48 * 1024 ** 3,
  diskNeededBytes: 40 * 1024 ** 3,
  diskComfortBytes: 480 * 1024 ** 3,
  coresComfort: 8,
  coresMin: 4,
};

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

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

/**
 * Pure threshold logic: map one measured byte/core value onto the three-tier
 * verdict. Exported for unit tests.
 */
export function assessDimension(
  dimension: string,
  value: number | undefined,
  min: number,
  comfort: number,
  basis: (v: number) => string,
): DimensionAssessment {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return { dimension, value: '未知', verdict: '不足', basis: '探测失败，无法评估', unknownData: true };
  }
  const verdict: Verdict = value >= comfort ? '充足' : value >= min ? '勉强' : '不足';
  return { dimension, value: fmtBytes(value), verdict, basis: basis(value), unknownData: false };
}

/** Assess the whole report against thresholds; overall = worst dimension. */
export function assessH3(
  report: SystemReport,
  thresholds: H3Thresholds = DEFAULT_H3_THRESHOLDS,
): H3Assessment {
  const mem = assessDimension('内存', report.totalMemBytes, thresholds.memMinBytes, thresholds.memFullBytes, (v) =>
    `总内存 ${fmtBytes(v)}；4-bit H3 约需 ${fmtBytes(thresholds.memFullBytes)} 统一内存（任务给定值），${fmtBytes(thresholds.memMinBytes)} 以下判定不足（估算）`);
  const disk = assessDimension('磁盘', report.freeDiskBytes, thresholds.diskNeededBytes, thresholds.diskComfortBytes, (v) =>
    `可用磁盘 ${fmtBytes(v)}；最小可用组合（GGUF Q4）约 33 GiB，此处按 ${fmtBytes(thresholds.diskNeededBytes)} 判定；官方 BF16 的 FL2VA 树 133.8 GiB、整仓 464.2 GiB`);
  const cores: DimensionAssessment = (() => {
    if (!Number.isFinite(report.cpuCount) || report.cpuCount <= 0) {
      return { dimension: 'CPU', value: '未知', verdict: '不足', basis: '探测失败，无法评估', unknownData: true };
    }
    const verdict: Verdict = report.cpuCount >= thresholds.coresComfort ? '充足' : report.cpuCount >= thresholds.coresMin ? '勉强' : '不足';
    return { dimension: 'CPU', value: `${report.cpuCount} 核`, verdict, basis: `≥${thresholds.coresComfort} 核充足、≥${thresholds.coresMin} 核勉强（估算）`, unknownData: false };
  })();
  const runtimeMissing = Object.entries(report.runtimes)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const runtime: DimensionAssessment = {
    dimension: '运行时',
    value: runtimeMissing.length === 0 ? 'python/uv/node 齐备' : `缺少 ${runtimeMissing.join('/')}`,
    verdict: runtimeMissing.length === 0 ? '充足' : runtimeMissing.length >= 2 ? '不足' : '勉强',
    basis: '离线 sidecar 需要 python + uv；node 为宿主自带，一般齐备',
    unknownData: false,
  };
  const dimensions = [mem, disk, cores, runtime];
  const rank: Record<Verdict, number> = { '充足': 0, '勉强': 1, '不足': 2 };
  const overall = dimensions.reduce<Verdict>((acc, d) => (rank[d.verdict] > rank[acc] ? d.verdict : acc), '充足');
  return { overall, dimensions };
}

/** Collect the report. `probes` is injectable for tests. */
export function collectSystemReport(
  targetDir: string,
  probes: typeof osProbes = osProbes,
): Promise<SystemReport> {
  return probes(targetDir);
}
