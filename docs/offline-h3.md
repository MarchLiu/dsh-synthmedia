# 离线 MiniMax-H3 部署与接入指引（本机实测版）

> **一句话结论**：本机（Apple M3 Max / 128 GiB 统一内存 / 约 1.4 TiB 可用磁盘）
> **可以本地跑 H3**，推荐 [antirez/h3.c](https://github.com/antirez/h3.c)——原生 Metal
> 引擎，直接吃官方 BF16 权重，不需要量化转换；代价是它 2026-08-11 之后没再更新。
> 想要 Turbo LoRA 的 4 步快路径和 ComfyUI 工作流，用
> [MacOS-H3-Speedrun](https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun)。
> 只剩空间、想先跑通，用 **GGUF 量化 + stable-diffusion.cpp**，全套约 33 GiB。
> 追求质量/速度上限仍然只有远端 Linux+NVIDIA（4×H200 约 12.6 s/条）。

采集时间：2026-11-13 ~ 11-14（Asia/Shanghai）。本文中数字分三类，**请按标注使用**：
**实测**＝本机命令输出；**上游实测**＝发布方在其测试机上的公开数字（注明机型）；
**估算**＝本文按 token 数/硬件差距折算，没有实测支撑。

## 1. 本机实测表

以下均为**实测**（命令原样给出，可复跑）：

| 项目 | 实测值 | 采集命令 |
|---|---|---|
| macOS 版本 | 26.6.2 (Build 25G83) | `sw_vers` |
| 架构 | arm64（Apple Silicon） | `uname -m` |
| 物理内存 | 137438953472 B = 128 GiB | `sysctl -n hw.memsize` |
| CPU 核数 | 16 | `sysctl -n hw.ncpu` |
| CPU 型号 | Apple M3 Max | `sysctl -n machdep.cpu.brand_string` |
| 数据卷可用空间 | 3.6 TiB 总量，1.4 TiB 可用 | `df -h /Users/mars/jobs/dsh-synthmedia` |
| Node | v24.22.2 | `node -v` |
| Python | Python 3.12.4 | `python3 --version` |
| uv | uv 0.8.13 (Homebrew 2025-08-21) | `uv --version` |
| ffmpeg | ✓ `/Users/mars/.local/bin/ffmpeg`，8.0.1-tessus | `which ffmpeg; ffmpeg -version` |
| ImageMagick | ✓ `/opt/homebrew/bin/magick`，7.1.2-35 Q16-HDRI | `which magick; magick --version` |
| GIMP | ✓ `/opt/homebrew/bin/gimp` | `which gimp` |
| Blender | ✓ `/opt/homebrew/bin/blender`，4.5.1 LTS | `which blender; blender --version` |

`node scripts/h3-setup.mjs --plan` 会复跑同一组只读探测并给出判定；磁盘可用量随系统
波动，以脚本实时输出为准。

工具链口径：`--plan` 是**部署前体检**，无条件探测全部四项；`/synthmedia detect` 与
`synthmedia_capabilities` 的 `tools` 段**只探测 `enabledTools` 里勾选的工具**（默认空
⇒ 不 spawn 任何进程，显示「工具链：未启用」）。

## 2. 阈值判定

阈值口径（与 `src/page/system.ts` 一致）：内存 **73 GiB**（4-bit/流式部署参考值）为
充足线、**48 GiB**（估算）为不足线；磁盘 **40 GiB**（= GGUF Q4 组合约 33 GiB + 余量，**实测尺寸**）为不足线、
**480 GiB**（= 整仓 464.2 GiB + 余量，**实测**）为充足线；CPU
**≥8 核充足 / ≥4 核勉强**（估算）。

磁盘实测依据（2026-11-13，HF/ModelScope 文件清单，`?blobs=true` 的 LFS 字节数）：

| 范围 | 文件数 | 体积 |
|---|---:|---:|
| 整仓（`hf download` 默认全下） | 280 | **464.2 GiB** |
| `FL2VA/` 单任务族（官方最小可用集） | 81 | **133.8 GiB** |
| `Ref2VA/` 单任务族 | 81 | 133.8 GiB |
| 根目录 diffusers 格式副本（`ModularPipeline` 用） | 118 | 196.0 GiB |
| GGUF Q4 组合（DiT 10.6 + 文本编码器 17.0 + 双 VAE 5.4） | 4 | **约 33 GiB** |

| 维度 | 本机实测 | 阈值（口径） | 判定 |
|---|---|---|---|
| 内存 | 128.0 GiB | 73 GiB 充足 / 48 GiB 不足（**估算**） | **充足** |
| 磁盘 | 约 1465 GiB 可用（采集时） | 40 GiB 不足线（**实测尺寸**）/ 480 GiB 充足线（**实测**） | **充足** |
| CPU | 16 核 | ≥8 核充足 / ≥4 核勉强（**估算**） | **充足** |
| 运行时 | python + uv + node 齐备 | 本地引擎需要 python 或 clang + ffmpeg | **充足** |

结论：硬件不构成瓶颈。真正的限制是**你选哪条运行时**（见第 3 节）。

## 3. 五条路线

### 3.0 最省空间：GGUF 量化 + stable-diffusion.cpp（先跑通）

社区已经量化好了： [unsloth/MiniMax-H3-GGUF](https://huggingface.co/unsloth/MiniMax-H3-GGUF)
（约 306 万次下载，最后更新 2026-10-16）提供 `fl2va_pruned` / `ref2va_pruned` 两套
DiT 的 Q2_K–Q8_0 与 UD 动态量化，以及配套的 Qwen3-VL 文本编码器；VAE 从
[Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) 取。**全套约 33 GiB**：

| 文件 | 体积 |
|---|---:|
| `minimax_h3_fl2va_pruned-Q4_K.gguf` | 10.64 GiB |
| `qwen3vl_32b_minimax_h3-Q4_K_M.gguf` | 16.97 GiB |
| `minimax_h3_video_vae_fp16.safetensors` + `minimax_h3_audio_vae_fp32.safetensors` | 5.41 GiB |

运行时是 [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
（2026-08-04 Day-1 支持 H3，带 Metal 后端）：

```bash
sd-cli --mode vid_gen \
  --diffusion-model minimax_h3_fl2va_pruned-Q4_K.gguf \
  --llm qwen3vl_32b_minimax_h3-Q4_K_M.gguf \
  --vae minimax_h3_video_vae_fp16.safetensors \
  --audio-vae minimax_h3_audio_vae_fp32.safetensors \
  --prompt "a red fox trotting through falling snow, cinematic" \
  --width 864 --height 480 --video-frames 56 --steps 4 --cfg-scale 1.0 \
  --diffusion-fa --offload-to-cpu --rng cpu --fps 24 \
  --output out.mp4
```

三个参数不是可选项：`--mode vid_gen`（否则走图像路径直接中止）、`--cfg-scale 1.0`
（H3 是蒸馏模型、不吃 CFG，默认 7.0 会中止）、以及 `--offload-to-cpu` / `--backend te=cpu`
（把 12–17 GiB 的文本编码器挪出显存）。

注意这是 **pruned + 量化**的 Model Derivatives，不是原版权重：质量低于 BF16 全量，
且 H3 Community License 的 III 节要求声明改动（仓库里有 NOTICE）。本机速度尚未实测。

### 3.1 本机原生 Metal：antirez/h3.c（推荐）

[C 实现 + Metal 内核](https://github.com/antirez/h3.c)，MIT，直接用官方 **BF16 原始权重**
（不转换、不量化），阶段化加载 transformer / Qwen 编码器 / VAE，Qwen 是流式读盘的。
README 明写优化目标是 **M3 Max 和 M5 Max**——正是本机。

**上游实测（M5 Max 128 GB）**：512×512、22 帧（0.92 s）、50 层、19 次去噪 **36.30 s**；
同形状 4 步草稿 **3.5 s**；`--layers 45 --reuse 2` 加 `--token-reduction` 去噪
**16.69 → 12.60 s**；`--ssd-streaming` 让 DiT 常驻从 36.5 GiB 降到 **2.0 GiB**；
128 GB 机上「图 + 音」端到端 74.58 s，峰值 40.1 GB，0 swap。

**本机估算**（M3 无 int8 TensorOps 路径，按 GPU 差距 1.5–2× 折算）：

| 形状 | M5 Max 上游实测 | M3 Max 估算 |
|---|---:|---:|
| 512² · 0.92 s · 20 步 | 36 s | 1–1.5 分钟 |
| 512² · 4.5 s（107 帧） | ≈175 s | 5–8 分钟 |
| 768p · 4.5 s | ≈400 s | 12–20 分钟 |

**下载权重**（只要 FL2VA 树）：

```bash
# Hugging Face 官方源
hf download MiniMaxAI/MiniMax-H3 --include "model_index.json" "FL2VA/*" --local-dir MiniMax-H3

# 国内走 hf-mirror（命令不变，只加端点）
HF_ENDPOINT=https://hf-mirror.com \
  hf download MiniMaxAI/MiniMax-H3 --include "model_index.json" "FL2VA/*" --local-dir MiniMax-H3

# ModelScope 源（注意仓库 id 是 MiniMax/…，分支是 master）
modelscope download MiniMax/MiniMax-H3 --include 'model_index.json' 'FL2VA/*' --local-dir MiniMax-H3

# 下载前核体积（不占盘）
curl -s "https://hf-mirror.com/api/models/MiniMaxAI/MiniMax-H3?blobs=true" \
  | python3 -c 'import sys,json;print(round(sum(f.get("size",0) for f in json.load(sys.stdin)["siblings"])/1024**3,1),"GiB")'
```

**编译与自检**（clang + Metal/MPSGraph，无第三方依赖；需要 Xcode CLT 与 ffmpeg/ffprobe）：

```bash
git clone https://github.com/antirez/h3.c && cd h3.c
make -j8
./h3 --info -d ./MiniMax-H3        # 校验权重布局 + 打印所选 Metal 设备
```

**出片**（先用 4 步草稿确认链路，再谈质量）：

```bash
# 草稿：0.9 秒，4 步
./h3 --profile -d ./MiniMax-H3 \
  -p "A red fox walks through fresh snow in a pine forest. Medium tracking shot." \
  --width 512 --height 512 --frames 22 --steps 4 --layers 50 --reuse 1 -o outputs/draft.mp4

# 默认档：20 步、45 层、reuse 2
./h3 --profile -d ./MiniMax-H3 -p "..." \
  --width 512 --height 512 --frames 22 --steps 20 --layers 45 --reuse 2 -o outputs/fox.mp4

# 省内存（DiT 常驻 36.5 → 2.0 GiB，单块 forward 慢 84%）
./h3 --profile -d ./MiniMax-H3 -p "..." --width 512 --height 512 --frames 22 \
  --steps 20 --layers 50 --reuse 1 --ssd-streaming -o outputs/fox-ssd.mp4
```

能力面：T2VA、首/尾帧条件、`--ref-image/-video/-audio` 的有序 Ref2VA 都支持，与插件的
H3 profile 语义一致。限制：4 步草稿对 29 步参考只有 SSIM 0.556（只能当草稿）；int8
加速仅 M5；仓库最后提交 2026-08-11、71 个 open issue、无 release。

### 3.2 本机 MLX + ComfyUI（质量档，Turbo LoRA）

[MacOS-H3-Speedrun](https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun) 按统一内存
自动选档并装好 ComfyUI 节点、Turbo LoRA 与 Sol-Attn：

```bash
git clone https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun
cd MacOS-H3-Speedrun
/path/to/ComfyUI/.venv/bin/python bootstrap.py --comfyui /path/to/ComfyUI --memory-tier auto
# 用 --use-pytorch-cross-attention 重启 ComfyUI，打开 Turbo4 工作流
```

本机 128 GB 落在 **96–128 GB 档**（BF16-pruned，峰值 63.35 GB）。安装期需 110–120 GB
临时磁盘。上游实测（M3 Ultra、864×480、Turbo4 + SolAttn）：480p/5.17 s **3 分 14 秒**，
480p/15.08 s **12 分 37 秒**，720p/5 s **9 分 20 秒**，720p/15.08 s **38 分 03 秒**。
M3 Max 预计慢 1.5–2×（估算）。

单独的节点项目：[yshenaw/ComfyUI-MiniMax-H3-MLX-SolAttn](https://github.com/yshenaw/ComfyUI-MiniMax-H3-MLX-SolAttn)；
注意力内核：[ComfyUI-SolAttn-MPS](https://github.com/yshenaw/ComfyUI-SolAttn-MPS)；
Turbo LoRA：[larryvrh/MiniMax-H3-Turbo-Lora](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora)。

### 3.3 本机 MLX CLI：appautomaton/mlx-h3

[纯 MLX 运行时](https://github.com/appautomaton/mlx-h3)（PyPI `mlx-h3`，Python 3.13+），
8-bit 权重包 [appautomaton/minimax-h3-base-8bit-mlx](https://huggingface.co/appautomaton/minimax-h3-base-8bit-mlx)
共 **102.7 GiB**（DiT FL2VA 34.75 + DiT Ref2VA 34.75 + Qwen3VL 27.73 + 双 VAE 5.4）。

```bash
uv tool install --prerelease allow mlx-h3
hf download appautomaton/minimax-h3-base-8bit-mlx --local-dir weights
uv run mlx-h3 "$PROMPT" --width 512 --height 288 --frames 124 --steps 20 --output out.mp4
# Turbo LoRA（4–8 步）：
uv run mlx-h3 "$PROMPT" --turbo-lora weights/adapters/minimax-h3-turbo/minimax_h3_turbo_v4_step600_ema.safetensors --steps 6 --output turbo.mp4
```

默认内存预算 70 GiB；画布须为 32 的倍数且不超过 `768*1344`；帧数按 `17n+5` 对齐。
适合脚本化/接插件，没有 HTTP 服务。

### 3.4 远端 Linux+NVIDIA（质量与速度上限）

官方唯一有文档背书的本地部署形态，需要 CUDA：

```bash
# vLLM-Omni
vllm serve MiniMaxAI/MiniMax-H3 --omni --port 8091
# SGLang diffusion（官方推荐拓扑：4 卡 Ulysses4）
sglang serve --model-path MiniMaxAI/MiniMax-H3 --model-variant fl2va \
  --num-gpus 4 --ulysses-degree 4 --performance-mode speed --port 30010
```

上游实测：4×H200 端到端 **≈12.6 s/条**（768p、124 帧）；2×H200 加 offload 23–47 s；
单卡 4090 24 GB（int8 + layerwise offload）1344×768/107 帧 20 步 **164–303 s**。
接入：

```bash
export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://<gpu-host>:8091
export SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL=minimax-h3
```

### 3.5 内网 videogen（已有服务）

```bash
export SYNTHMEDIA_LOCAL_H3_BASE_URL=https://<videogen-host>   # 默认 http://127.0.0.1:8791
export SYNTHMEDIA_LOCAL_H3_AUTH=<user:password 或 bearer token>
```

对应 profile 是 `local-h3`（`videogen-task-api` 协议），与 sidecar profile 互不影响。

### 3.6 明确不推荐

- **PipeNetwork/minimax-h3-mlx**：研究级移植，bf16 一条 5 s 片要 8.8 min/步，不可用于生产。
- **plain `ollama run`**：Ollama 没有文档化的 H3 视频路径。
- **Windows 原生**：没有官方扩散运行时；WSL2 或走远端。
- **macOS 上的 vLLM-Omni / SGLang**：官方仅支持 Linux+NVIDIA。

## 4. 接入 synthmedia

上面所有本机引擎都只有 CLI（或 ComfyUI 图），**没有 OpenAI 兼容的 `/v1/videos`**，
所以需要一个 sidecar 把 CLI 包成 HTTP：

| 客户端调用 | sidecar 行为 |
|---|---|
| `POST /v1/videos` | 起一个 `./h3 -p … -o …`（或 `uv run mlx-h3 …`）子进程，返回任务 id |
| `GET /v1/videos/{id}` | 读子进程状态；有 `--profile`/`--show` 输出时据此估进度 |
| `GET /v1/videos/{id}/content` | 流式返回生成的 mp4 |
| `DELETE /v1/videos/{id}` | 终止子进程，保留已写出的部分文件 |

起好后：

```bash
export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://127.0.0.1:8099
export SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL=minimax-h3
```

`local-h3-sidecar` profile（`openai-video-compatible`）即可原样使用：`POST /v1/videos`
提交 → `GET /v1/videos/{id}` 轮询 → `GET /v1/videos/{id}/content` 取产物，`DELETE` 取消，
可选 `POST /v1/videos/sync`。默认 `timeoutMs` 30 分钟，Mac 上跑 768p 长片时按需上调。

## 5. 故障排查

| 症状 | 排查 |
|---|---|
| `make` 失败 / 找不到 Metal 头 | 装 Xcode Command Line Tools（`xcode-select --install`）；本项目用运行时编译 Metal 源，不依赖离线 `metal` 工具链 |
| `./h3 --info` 报权重布局错误 | `-d` 要指向含 `FL2VA/` 与 `model_index.json` 的目录；ModelScope 下完的目录结构与此相同 |
| MP4 写不出来 | `ffmpeg`/`ffprobe` 必须在 `PATH`（或用 `H3_FFMPEG`/`H3_FFPROBE` 指定） |
| 出现 NaN / 花屏 | 不要用 `--force-fp16` 之类的半精度覆盖；保持 checkpoint 默认 BF16/混合精度 |
| 4 步出片画面崩 | 4 步仅草稿档（SSIM 0.556）；先用 20 步复现同一 prompt |
| 显存/统一内存吃紧 | 加 `--ssd-streaming`；或 `--layers 45/40`；`--show` 会额外常驻约 10 GiB 预览 VAE |
| 任务长期 `progress 0` | 队列阶段 progress 就是 0（zgci-h3 曾 0% 停留约 30 分钟），先看服务端日志，勿盲目调低 timeout |
| 超时 | `local-h3-sidecar` 默认 30 分钟；Mac 上 768p 长片请上调 profile 覆盖 |
| 代理 | `hf download` 走不通时用 `HF_ENDPOINT=https://hf-mirror.com`；给本地 sidecar 设 `NO_PROXY=127.0.0.1,localhost` |

## 6. 接入成功后怎么验

1. `/synthmedia detect`：确认硬件探测、工具链四项与生态门禁输出（`enabledTools` 为空时
   显示「未启用」属预期，先在 Config 页勾选）。
2. `synthmedia_capabilities()`：`local-h3-sidecar` 应出现 `priority`、`supported: true`、
   `ecosystem: 'h3'`、`effectiveDefault`（若它是该模态下排最前的 supported profile），
   以及 `tools` 段。
3. 最小 generate：`synthmedia_generate({ backend: 'local-h3-sidecar', model: 'minimax-h3',
   modality: 'video', prompt: 'a red paper plane over the Pacific', durationSeconds: 4 })`，
   然后 `synthmedia_wait({ id })`。
4. 产物核验：`<outputDir>/<jobId>/result.mp4` + `job.json`，`ffprobe result.mp4` 确认
   时长/分辨率。

## 7. 未核验 / 待填清单

以下内容**没有实测支撑**，使用前请自行核验：

- **M3 Max 的端到端耗时**：h3.c 上游数字全部来自 M5 Max；本文的 1.5–2× 是估算。
- **h3.c 的稳定性**：最后提交 2026-08-11，71 个 open issue，无 release；崩溃需自读 C 代码。
- **Speedrun / ComfyUI 路线在 M3 Max 上的实测**：上游测试机是 M3 Ultra / M5。
- **4 步 / Turbo4 档的交付级质量**：只有草稿级验证（SSIM 0.556、人工观感），没有正式评估。
- **int8 加速**：h3.c 的 int8 与 mlx-h3 的 NAX 都依赖 M5；M3 Max 走 BF16 路径。
- **许可**：权重是 MiniMax-H3 Community License（商用有条款）；Turbo LoRA、MLX 移植、
  h3.c 均为社区/非官方产物，官方只保证 vLLM-Omni / SGLang / diffusers / ComfyUI 路径。
