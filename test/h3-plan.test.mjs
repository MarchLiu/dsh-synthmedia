/**
 * h3-setup --plan pure-function tests: buildPlan reflects the measured report,
 * the threshold verdicts, and the platform-specific recommended paths — no
 * I/O, no subprocess.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { buildPlan } = await import('../scripts/h3-setup.mjs');

const GIB = 1024 ** 3;

function fakeReport(overrides = {}) {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuCount: 16,
    cpuModel: 'Apple M3 Max',
    totalMemBytes: 128 * GIB,
    freeDiskBytes: 1400 * GIB,
    appleSilicon: true,
    gpuInfo: 'Apple Silicon 集成 GPU',
    runtimes: { python: 'python3 3.12', uv: 'uv 0.8', node: 'node v24' },
    ...overrides,
  };
}

function fakeAssessment(overall = '充足') {
  return {
    overall,
    dimensions: [
      { dimension: '内存', value: '128.0 GiB', verdict: overall, basis: '测试', unknownData: false },
    ],
  };
}

test('plan echoes measured hardware and per-dimension verdicts', () => {
  const lines = buildPlan({ report: fakeReport(), assessment: fakeAssessment(), toolchain: [] });
  const text = lines.join('\n');
  assert.ok(text.includes('Apple M3 Max'));
  assert.ok(text.includes('128.0 GiB'));
  assert.ok(text.includes('综合判定：充足'));
  assert.ok(text.includes('内存：128.0 GiB → 充足'));
});

test('Apple Silicon + sufficient memory recommends the native Metal engine, then MLX, with Linux+NVIDIA as the ceiling', () => {
  const text = buildPlan({ report: fakeReport(), assessment: fakeAssessment() }).join('\n');
  assert.ok(text.includes('antirez/h3.c'), 'native Metal path is the primary recommendation');
  assert.ok(text.includes('MLX'), 'MLX quality tier is still named');
  assert.ok(text.includes('Linux+NVIDIA'));
  assert.ok(text.includes('SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL'));
  assert.ok(text.includes('133.8 GiB'), 'plan quotes the measured FL2VA size');
});

test('Apple Silicon below the 48 GiB floor is declared infeasible; mid band marked 勉强', () => {
  const low = buildPlan({
    report: fakeReport({ totalMemBytes: 32 * GIB }),
    assessment: fakeAssessment('不足'),
  }).join('\n');
  assert.ok(low.includes('离线不可行') || low.includes('不足'));
  assert.ok(!low.includes('本机可以承载完整离线 H3'));
  const mid = buildPlan({
    report: fakeReport({ totalMemBytes: 64 * GIB }),
    assessment: fakeAssessment('勉强'),
  }).join('\n');
  assert.ok(mid.includes('勉强'));
});

test('non-Apple-Silicon report points at the official Linux+NVIDIA deployment docs', () => {
  const text = buildPlan({
    report: fakeReport({ appleSilicon: false, platform: 'linux', gpuInfo: undefined }),
    assessment: fakeAssessment(),
  }).join('\n');
  assert.ok(text.includes('非 Apple Silicon'));
  assert.ok(text.includes('vLLM-Omni'));
});

test('plan includes the hf-download recommendation and the manifest-as-topup framing', () => {
  const text = buildPlan({ report: fakeReport(), assessment: fakeAssessment(), toolchain: [] }).join('\n');
  assert.ok(text.includes('hf download MiniMaxAI/MiniMax-H3'));
  assert.ok(text.includes('单文件补拉'));
  assert.ok(text.includes('node scripts/h3-setup.mjs --download'));
});

test('plan surfaces toolchain statuses when provided', () => {
  const text = buildPlan({
    report: fakeReport(),
    assessment: fakeAssessment(),
    toolchain: [
      { name: 'ffmpeg', installed: true, version: 'ffmpeg version 7.1' },
      { name: 'blender', installed: false },
    ],
  }).join('\n');
  assert.ok(text.includes('ffmpeg✓'));
  assert.ok(text.includes('blender✗'));
});
