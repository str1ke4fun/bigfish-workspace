#!/usr/bin/env python3
"""dsh-wx 向量侧车（B 档）：本地 Qwen3-Embedding-0.6B 的只读 HTTP 服务。

为什么单独起一个进程：
  dsh-wx 是零依赖 Node 插件，不能把 torch/transformers 塞进去；
  WSL 里的 Python 没有 CUDA 版 torch，而 Windows 侧的 venv 有。
  所以模型跑在有 GPU 的那一侧，插件只通过本机 localhost 说话（见 forward.mjs）。

接口（只给本机用，别绑到公网）：
  GET  /health          → {"ok":true,"model":...,"dim":1024,"device":...}
  POST /embed           → {"model":...,"embeddings":[[...],...],"dim":1024}
       body: {"model":"qwen3-embedding-0.6b","input":["文本", ...]}
       也接受 input 为单个字符串；最多 64 条。

口径（见 agent-memory-full-index 的开发计划）：
  - Qwen3-Embedding 用最后一个 token 的隐藏状态（left padding）；
  - 输出转 FP32 后 L2 normalize；
  - local_files_only=True，不联网；
  - bf16 + SDPA，GPU 可用时优先 GPU。

不写任何文件、不读任何凭据、不记录请求正文。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_INPUTS = 64
MAX_CHARS = 8000
DIM = 1024
MAX_TOKENS = 1024

_lock = threading.Lock()
_state = {"model": None, "tokenizer": None, "device": "cpu", "name": "", "dim": DIM}


def log(msg: str) -> None:
    print(f"[embed] {msg}", file=sys.stderr, flush=True)


def load_model(path: str, device: str) -> None:
    import torch
    from transformers import AutoModel, AutoTokenizer

    want = device
    if device == "auto":
        want = "cuda" if torch.cuda.is_available() else "cpu"
    if want == "cuda" and not torch.cuda.is_available():
        log("CUDA 不可用，退回 CPU（会慢）")
        want = "cpu"

    dtype = torch.bfloat16 if want == "cuda" else torch.float32
    tok = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=False)
    tok.padding_side = "left"
    model = AutoModel.from_pretrained(
        path,
        local_files_only=True,
        trust_remote_code=False,
        dtype=dtype,
        attn_implementation="sdpa",
    )
    model.to(want).eval()
    _state.update({
        "model": model,
        "tokenizer": tok,
        "device": want,
        "name": os.path.basename(os.path.normpath(path)),
        "dim": int(getattr(model.config, "hidden_size", DIM)),
    })
    log(f"模型已加载：{path} → {want}（dim={_state['dim']}）")


def embed(texts: list[str]) -> list[list[float]]:
    import torch

    model = _state["model"]
    tok = _state["tokenizer"]
    if model is None or tok is None:
        raise RuntimeError("模型还没加载")
    batch = tok(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_TOKENS,
        return_tensors="pt",
    )
    batch = {k: v.to(_state["device"]) for k, v in batch.items()}
    with _lock, torch.inference_mode():
        hidden = model(**batch).last_hidden_state
        idx = batch["attention_mask"].sum(dim=1) - 1
        vec = hidden[torch.arange(hidden.size(0), device=hidden.device), idx]
        vec = torch.nn.functional.normalize(vec.float(), p=2, dim=1)
        return vec.cpu().tolist()


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-wx-embed/1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # 默认的访问日志会带路径，但不带正文；保留一行便于排查超时。
        log("%s %s" % (self.command, self.path) if hasattr(self, "command") else fmt % args)

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self._send(404, {"ok": False, "error": "not found"})
            return
        self._send(200, {
            "ok": _state["model"] is not None,
            "model": _state["name"],
            "dim": _state["dim"],
            "device": _state["device"],
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/embed":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > 2_000_000:
                raise ValueError("请求体为空或过大")
            raw = json.loads(self.rfile.read(n).decode("utf-8"))
            inp = raw.get("input")
            texts = [inp] if isinstance(inp, str) else inp
            if not isinstance(texts, list) or not texts:
                raise ValueError("input 需要是非空字符串或字符串数组")
            if len(texts) > MAX_INPUTS:
                raise ValueError(f"一次最多 {MAX_INPUTS} 条")
            texts = [str(t)[:MAX_CHARS] for t in texts]
            t0 = time.time()
            vectors = embed(texts)
            ms = int((time.time() - t0) * 1000)
            log(f"embed {len(texts)} 条 → {ms} ms")
            self._send(200, {
                "model": str(raw.get("model") or _state["name"]),
                "dim": _state["dim"],
                "embeddings": vectors,
            })
        except Exception as err:  # noqa: BLE001
            log("embed 失败：" + repr(err))
            self._send(400, {"ok": False, "error": str(err)[:300]})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="模型目录（本机路径）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18731)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = ap.parse_args()

    load_model(args.model, args.device)
    # 预热：把 CUDA kernel 和 tokenizer 的第一次开销放在启动时，别让第一次检索等。
    embed(["预热"])

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"监听 http://{args.host}:{args.port}（device={_state['device']}）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
