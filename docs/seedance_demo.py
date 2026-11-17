#!/usr/bin/env python3
"""用火山引擎方舟（Volcengine Ark）调用 Seedance 生成视频（演示脚本，只用 Python 标准库）。

前提：在方舟控制台开通对应的 Seedance 视频生成模型，并创建 API Key。
费用按方舟官方 token 计费口径，实际以方舟控制台账单为准。

用法：
  export ARK_API_KEY=你的方舟APIKey
  # 文生视频
  python3 seedance_demo.py "一只橘猫在窗台上伸懒腰，午后阳光，镜头缓慢推近"
  # 图生视频（图片作为首帧）
  python3 seedance_demo.py "人物转身走向门口" --image first.png
  # 换模型、时长、清晰度
  python3 seedance_demo.py "海浪拍打礁石" --model doubao-seedance-2.0 --duration 10 --resolution 720p

流程：提交任务 → 每 10 秒查询一次进度（总超时由 --timeout 控制，默认 600 秒）→ 成功后把 mp4 下载到当前目录。
视频下载地址由火山返回，24 小时内有效。

Endpoint 说明（可选覆盖）：
  默认连接火山引擎方舟公开地址 https://ark.cn-beijing.volces.com/api/v3，
  任务路径为 /contents/generations/tasks（POST 创建、GET 查询 /{id}，DELETE 取消）。
  base URL 的取值优先级：--base-url 参数 > 环境变量 ARK_BASE_URL > 内置 DEFAULT_BASE_URL。
  任何 Ark 兼容网关（自建代理、其它云上的同构实现）都可以通过覆盖 base URL 复用本脚本——
  任务路径与请求体不用改。示例：
    # 官方地址（默认）
    python3 seedance_demo.py "..." --base-url https://ark.cn-beijing.volces.com/api/v3
    # Ark 兼容网关（占位示例，换成你自己的网关地址）
    python3 seedance_demo.py "..." --base-url https://your-ark-gateway.example.com/api/v3

模型 id 说明：--model / ARK_MODEL 接受任意字符串透传，不做白名单校验。
模型 id 以方舟控制台与官方文档为准，各区域/各套餐的可用集合不同；常见命名形态如
doubao-seedance-2.0、doubao-seedance-2.0-fast、doubao-seedance-2.5（仅作示例，非完整列表）。

退出码约定：
  0 成功；2 参数错误（含未提供 prompt）；3 鉴权 / HTTP 请求错误；4 任务失败；5 轮询超时。
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
TASKS = "/contents/generations/tasks"

# 相比旧版修掉的两个已知缺陷（此处显式说明，不是默默改）：
# 1) 轮询不再 while True 死循环：新增 --timeout 总超时（默认 600 秒），超时以退出码 5 结束，
#    并提示可用 ARK_MODEL/任务 id 直接 GET 查询或去方舟控制台查看任务状态。
# 2) usage 字段缺失时不再静默按 0 处理：明确打印「未返回 usage，计费以方舟控制台为准」。


def call(method, url, key, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        print(f"请求失败：HTTP {e.code}\n{detail}", file=sys.stderr)
        sys.exit(3)
    except urllib.error.URLError as e:
        print(f"网络错误：{e.reason}", file=sys.stderr)
        sys.exit(3)


def image_as_data_url(path):
    mime = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def main():
    p = argparse.ArgumentParser(description="Seedance 视频生成演示（火山引擎方舟）")
    p.add_argument("prompt", nargs="?", help="视频描述（必填）")
    p.add_argument("--image", help="首帧图片（本地文件），不传就是文生视频")
    p.add_argument("--model", default=os.environ.get("ARK_MODEL", "doubao-seedance-2.5"),
                   help="模型 id，任意字符串透传；默认取 ARK_MODEL 或 doubao-seedance-2.5。"
                        "可用集合以方舟控制台与官方文档为准")
    p.add_argument("--duration", type=int, default=5, help="秒数，默认 5")
    p.add_argument("--resolution", default="480p", help="480p / 720p / 1080p，默认 480p")
    p.add_argument("--ratio", default="adaptive", help="画面比例，如 16:9、9:16、1:1，默认 adaptive")
    p.add_argument("--no-audio", action="store_true", help="不生成声音")
    p.add_argument("--out", help="输出文件名，默认 <任务ID>.mp4")
    p.add_argument("--timeout", type=int, default=600, help="轮询总超时秒数，默认 600")
    p.add_argument("--base-url", default=os.environ.get("ARK_BASE_URL", DEFAULT_BASE_URL),
                   help="Ark 兼容网关 base URL，默认官方地址 %s；覆盖后任务路径与请求体不变" % DEFAULT_BASE_URL)
    args = p.parse_args()

    if not args.prompt:
        print("用法示例：python3 seedance_demo.py \"提示词\" [--image 首帧.png]\n"
              "缺少 prompt 参数。运行 --help 查看完整用法。", file=sys.stderr)
        sys.exit(2)

    key = os.environ.get("ARK_API_KEY")
    if not key:
        print("请先设置环境变量 ARK_API_KEY（在火山引擎方舟控制台创建/复制 API Key）", file=sys.stderr)
        sys.exit(3)
    base = args.base_url.rstrip("/")

    content = [{"type": "text", "text": args.prompt}]
    if args.image:
        content.append({"type": "image_url", "role": "first_frame",
                        "image_url": {"url": image_as_data_url(args.image)}})
    body = {
        "model": args.model,
        "content": content,
        "ratio": args.ratio,
        "duration": args.duration,
        "resolution": args.resolution,
        "generate_audio": not args.no_audio,
        "watermark": False,
    }

    task_id = call("POST", base + TASKS, key, body)["id"]
    print(f"任务已提交：{task_id}")

    started = time.time()
    while True:
        if time.time() - started > args.timeout:
            print(f"轮询超过总超时 {args.timeout} 秒仍未完成，退出（任务 id：{task_id}）。\n"
                  f"可稍后直接 GET {base}{TASKS}/{task_id} 继续查询，或到方舟控制台查看任务状态。",
                  file=sys.stderr)
            sys.exit(5)
        time.sleep(10)
        task = call("GET", f"{base}{TASKS}/{task_id}", key)
        status = task.get("status")
        print(f"  {int(time.time() - started):>4} 秒  {status}")
        if status == "succeeded":
            break
        if status in ("failed", "cancelled", "expired"):
            print(f"生成失败：{json.dumps(task.get('error') or task, ensure_ascii=False)}", file=sys.stderr)
            sys.exit(4)

    url = task["content"]["video_url"]
    out = args.out or f"{task_id}.mp4"
    with urllib.request.urlopen(url, timeout=300) as r, open(out, "wb") as f:
        f.write(r.read())

    print(f"完成：{out}（{task.get('duration')} 秒，{task.get('resolution', args.resolution)}）")
    usage = task.get("usage")
    if usage:
        print(f"用量：completion_tokens={usage.get('completion_tokens')}，"
              f"total_tokens={usage.get('total_tokens')}（实际计费以方舟控制台为准）")
    else:
        # 缺陷修复：usage 缺失时不再静默当 0，明确提示计费口径。
        print("接口未返回 usage，计费以方舟控制台为准")


if __name__ == "__main__":
    main()
