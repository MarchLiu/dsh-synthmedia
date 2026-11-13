#!/usr/bin/env node
/**
 * Offline H3 setup helper — NO third-party dependencies, plain `node scripts/h3-setup.mjs`.
 *
 * Modes:
 *   --plan              Print measured hardware + threshold verdict + the
 *                       recommended integration path command list (READ-ONLY).
 *   --download          Run the shipped download manifest through the plugin's
 *                       own DownloadManager (no DSH host needed). Optional:
 *                         --only <id>     just one manifest entry
 *                         --data-dir <d>  plugin data dir (default synthmedia-data)
 *                       Ctrl-C cancels; the .part file is kept for resume.
 *   --check <baseURL>   One health probe against a running H3 sidecar
 *                       (GET <baseURL>/v1/models, 5 s timeout).
 *
 * The plan TEXT is produced by the exported PURE function buildPlan();
 * this file only does I/O around it, so tests can assert on buildPlan.
 * Requires `pnpm build` first (imports the compiled lib/).
 */
import { defaultManifest, DownloadManager } from '../lib/page/downloads.js';
import { collectSystemReport, assessH3, DEFAULT_H3_THRESHOLDS } from '../lib/page/system.js';
import { detectToolchain } from '../lib/page/toolchain.js';
import { TOOL_NAMES } from '../lib/page/priority.js';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { join, resolve } from 'node:path';

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

const GIB = 1024 ** 3;

/**
 * PURE: build the human-readable plan lines from measured inputs.
 * No I/O here — collectSystemReport/detectToolchain results go IN.
 */
export function buildPlan({ report, assessment, toolchain }) {
  const lines = [];
  const memGiB = report.totalMemBytes !== undefined ? report.totalMemBytes / GIB : undefined;
  const diskGiB = report.freeDiskBytes !== undefined ? report.freeDiskBytes / GIB : undefined;
  lines.push('== 本机实测（只读探测，逐项命令见 docs/offline-h3.md）==');
  lines.push(`平台 ${report.platform}/${report.arch}${report.appleSilicon ? '（Apple Silicon）' : ''} · CPU ${report.cpuCount} 核 ${report.cpuModel ?? '型号未知'}`);
  lines.push(`内存 ${memGiB !== undefined ? `${memGiB.toFixed(1)} GiB` : '未知'} · 数据目录所在卷可用 ${diskGiB !== undefined ? `${diskGiB.toFixed(0)} GiB` : '未知'}`);
  lines.push(`GPU：${report.gpuInfo ?? '未探测到独显信息'}`);
  lines.push(`运行时：python=${report.runtimes.python ?? '未找到'} · uv=${report.runtimes.uv ?? '未找到'} · node=${report.runtimes.node ?? '未找到'}`);
  if (Array.isArray(toolchain) && toolchain.length > 0) {
    lines.push('工具链：' + toolchain.map((t) => `${t.name}${t.installed ? `✓ ${t.version ?? ''}`.trimEnd() : '✗'}`).join(' · '));
  }
  lines.push('');
  lines.push('== 阈值判定（73/48 GiB 内存估、40/480 GiB 磁盘实测、8/4 核估）==');
  for (const d of assessment.dimensions) lines.push(`- ${d.dimension}：${d.value} → ${d.verdict}（${d.basis}）`);
  lines.push(`综合判定：${assessment.overall}`);
  lines.push('');
  lines.push('== 推荐路径（按本机判定生成）==');
  const memOk = memGiB !== undefined && memGiB >= DEFAULT_H3_THRESHOLDS.memFullBytes / GIB;
  const appleSilicon = report.appleSilicon === true;
  if (appleSilicon) {
    lines.push('本机是 Apple Silicon：官方 vLLM-Omni / SGLang 只支持 Linux+NVIDIA，但本机有原生 Metal 与 MLX 两条社区路线（详见 docs/offline-h3.md）。');
    if (memOk) {
      lines.push('内存满足门槛——本机可以承载完整离线 H3（h3.c 直接吃官方 BF16 权重，无需量化转换）。');
    } else if (memGiB !== undefined && memGiB >= DEFAULT_H3_THRESHOLDS.memMinBytes / GIB) {
      lines.push('内存处于「勉强」档（估算）：只能走 MLX 的量化/分档路由（ComfyUI 24–48 GB 档）。');
    } else {
      lines.push('内存低于「勉强」档：本机离线不可行，建议远端 GPU。');
    }
    lines.push('');
    lines.push('先跑通这一步 —— GGUF 量化 + stable-diffusion.cpp（全套约 33 GiB，最省空间）：');
    lines.push('  # unsloth/MiniMax-H3-GGUF: fl2va_pruned-Q4_K 10.6 GiB + qwen3vl_32b-Q4_K_M 17.0 GiB');
    lines.push('  # VAE 从 Comfy-Org/MiniMax-H3 取；sd-cli 见 https://github.com/leejet/stable-diffusion.cpp');
    lines.push('  sd-cli --mode vid_gen --diffusion-model <dit-Q4_K.gguf> --llm <qwen3vl-Q4_K_M.gguf> \\');
    lines.push('    --vae <video_vae.safetensors> --audio-vae <audio_vae.safetensors> \\');
    lines.push('    --prompt "..." --width 864 --height 480 --video-frames 56 --steps 4 \\');
    lines.push('    --cfg-scale 1.0 --diffusion-fa --offload-to-cpu --rng cpu --fps 24 -o out.mp4');
    lines.push('  # --mode vid_gen / --cfg-scale 1.0 / --offload-to-cpu 三个参数不可省；速度快慢本机未实测。');
    lines.push('推荐 A（本机原生 Metal，首选）—— antirez/h3.c，MIT，最后提交 2026-08-11：');
    lines.push('  git clone https://github.com/antirez/h3.c && cd h3.c && make -j8');
    lines.push('  ./h3 --info -d ./MiniMax-H3');
    lines.push('  ./h3 -d ./MiniMax-H3 -p "..." --width 512 --height 512 --frames 22 --steps 4 --layers 50 --reuse 1 -o draft.mp4');
    lines.push('  上游实测（M5 Max）：512²/22 帧 19 次去噪 36.3 s；4 步草稿 3.5 s。M3 Max 估算 1.5–2×。');
    lines.push('');
    lines.push('推荐 B（质量档）—— MLX + ComfyUI：MacOS-H3-Speedrun（Turbo LoRA + Sol-Attn，按内存自动选档）。');
    lines.push('  本机 128 GB 落在 96–128 GB 档（BF16-pruned，峰值约 63 GB）；安装期需 110–120 GB 临时磁盘。');
    lines.push('');
    lines.push('推荐 C（脚本化）—— appautomaton/mlx-h3：8-bit 权重包 102.7 GiB，默认 70 GiB 内存预算，无 HTTP 服务。');

    lines.push('');
    lines.push('推荐 D（对照）—— 远端 Linux+NVIDIA GPU（质量与速度上限，4×H200 ≈12.6 s/条）：');
    lines.push('  export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://<gpu-host>:8091');
    lines.push('  export SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL=minimax-h3');
    lines.push('');
    lines.push('本机引擎只提供 CLI，接插件需要一个 /v1/videos sidecar（见 docs/offline-h3.md 第 4 节）。');
  } else {
    lines.push('非 Apple Silicon：若为 Linux+NVIDIA，走官方 vLLM-Omni / SGLang（README「Offline deployment」A/B）；其余平台建议远端 GPU。');
    lines.push('  export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://127.0.0.1:8091');
    lines.push('  export SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL=minimax-h3');
  }
  lines.push('');
  lines.push('模型文件体积（2026-11-13 实测，HF/ModelScope 文件清单）：整仓 464.2 GiB；');
  lines.push('官方最小可用集 FL2VA/ 133.8 GiB；Ref2VA/ 133.8 GiB；根 diffusers 副本 196.0 GiB。');
  lines.push('下载（推荐只取 FL2VA，保留 Diffusers 目录结构；本清单定位为「单文件补拉」）：');
  lines.push('  pip install -U "huggingface_hub[cli]"');
  lines.push('  hf download MiniMaxAI/MiniMax-H3 --include "model_index.json" "FL2VA/*" --local-dir ./models/MiniMax-H3');
  lines.push('  # 国内镜像：HF_ENDPOINT=https://hf-mirror.com hf download MiniMaxAI/MiniMax-H3 --include "model_index.json" "FL2VA/*" --local-dir ./models/MiniMax-H3');
  lines.push('  # ModelScope：modelscope download MiniMax/MiniMax-H3 --include \'model_index.json\' \'FL2VA/*\' --local-dir ./MiniMax-H3');
  lines.push('  # 或用本清单补拉单文件：node scripts/h3-setup.mjs --download [--only <id>]');
  return lines;
}

/** Entry: --plan. Read-only probes + pure plan builder. */
async function plan(dataDir) {
  const report = await collectSystemReport(dataDir);
  const assessment = assessH3(report, DEFAULT_H3_THRESHOLDS);
  const toolchain = await detectToolchain(TOOL_NAMES);
  const lines = buildPlan({ report, assessment, toolchain });
  console.log(lines.join('\n'));
}

/** Entry: --download. Drives DownloadManager headlessly with progress on stdout. */
async function download(opts) {
  const dataDir = resolve(opts.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const downloadsDir = join(dataDir, 'downloads');
  const manager = new DownloadManager(defaultManifest(downloadsDir));
  await manager.loadManifest(join(dataDir, 'downloads.json'));
  const targets = opts.only
    ? [opts.only]
    : manager.manifestNow().entries.map((e) => e.id);
  if (targets.length === 0) {
    console.log('清单为空，无事可做。');
    return;
  }
  const started = [];
  for (const id of targets) {
    try {
      const rec = await manager.start(id);
      started.push(rec.id);
      console.log(`[start] ${id} — ${rec.name}`);
    } catch (err) {
      console.error(`[skip ] ${id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const render = () => {
    for (const d of manager.list()) {
      if (!started.includes(d.id)) continue;
      const pct = d.percent !== undefined ? `${d.percent}%` : '…';
      const speed = d.speedBps !== undefined ? ` ${(d.speedBps / 1024 / 1024).toFixed(1)} MiB/s` : '';
      const err = d.error ? ` — ${d.error}` : '';
      console.log(`[${d.status}] ${d.id} ${pct} (${Math.round((d.downloadedBytes ?? 0) / 1024 / 1024)} MiB)${speed}${err}`);
    }
  };
  const timer = setInterval(render, 1000);
  const idleSince = () => manager.list().filter((d) => started.includes(d.id) && d.status === 'running').length;
  while (idleSince() > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }
  clearInterval(timer);
  render();
  const done = manager.list().filter((d) => started.includes(d.id));
  const ok = done.filter((d) => d.status === 'completed').length;
  console.log(`完成：${ok}/${started.length}；失败/取消的条目保留 .part 文件，可重新运行 --download 续传。`);
  process.exitCode = ok === started.length ? 0 : 1;
}

/** Entry: --check <baseURL>. One health probe, no retry storm. */
async function check(baseURL) {
  const base = baseURL.replace(/\/+$/, '');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${base}/v1/models`, { signal: controller.signal });
    const text = await resp.text();
    console.log(`GET ${base}/v1/models → HTTP ${resp.status} (${text.length} bytes)`);
    let okModels = false;
    try {
      const body = JSON.parse(text);
      const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
      if (ids.length > 0) {
        console.log(`models: ${ids.join(', ')}`);
        okModels = true;
      }
    } catch { /* non-JSON body is fine for some gateways */ }
    console.log(okModels ? '健康检查通过（模型列表可读）。' : '服务可达但未返回标准 /v1/models 数据——请核对该网关的模型列表端点。');
  } catch (err) {
    console.error(`健康检查失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(t);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(`--${name}`);
  const dataDir = flag('data-dir') ?? 'synthmedia-data';
  if (has('plan')) return plan(dataDir);
  if (has('download')) return download({ dataDir, only: flag('only') });
  const url = flag('check');
  if (url) return check(url);
  console.log('用法：node scripts/h3-setup.mjs --plan | --download [--only <id>] [--data-dir <dir>] | --check <baseURL>');
  process.exitCode = 2;
}

// Only run the CLI when executed directly; importing this module (e.g. from
// the test suite) must stay side-effect free.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href;
if (invokedDirectly) main();
