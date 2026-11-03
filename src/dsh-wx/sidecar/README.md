# dsh-wx 向量侧车（B 档）

A 档是词法检索（CJK bigram + BM25），不依赖任何外部服务。B 档是可选的语义近邻：
本地 Qwen3-Embedding-0.6B + 余弦相似度 + RRF 融合。侧车没起、超时或维度不对时，
`vector.js` 静默退回 A 档，并在 10 分钟内不再重试。

## 组件

| 文件 | 跑在哪 | 作用 |
| --- | --- | --- |
| `embed_server.py` | 有 GPU/模型的那一侧（这台机器是 Windows） | 加载模型，提供 `/health`、`/embed` |
| `forward.mjs` | WSL（插件所在侧） | 把 `127.0.0.1:8731` 转发到 Windows 的 `18731` |

插件只认本机地址，所以 WSL 侧必须用转发器；不要改 `parseVectorConfig` 去放宽到网关 IP。

## 启动

Windows（PowerShell，替换成实际的 venv 与模型路径）：

```powershell
& "C:\Users\ASUS\Desktop\agent-memory-full-index\.venv\Scripts\python.exe" `
  "\\wsl.localhost\Ubuntu-26.10\home\str1k3\src\bigfish-workspace\src\dsh-wx\sidecar\embed_server.py" `
  --model "C:\Users\ASUS\Desktop\agent-memory-full-index\Qwen3-Embedding-0.6B" `
  --host 172.31.208.1 --port 18731
```

`--host` 必须是 WSL 能访问到的 Windows 地址（默认网关，`ip route | grep default` 的网关）。
只绑这个地址，不要绑 `0.0.0.0`。UNC 路径里的发行版名用 `wsl.exe -l -q` 查到的实际名字，
不一定是 `Ubuntu`。模型加载需要几十秒，`/health` 没响应时先看 `embed-server.err`，不要急着重启。

WSL：

```bash
DSH_EMBED_TARGET=http://172.31.208.1:18731 node src/dsh-wx/sidecar/forward.mjs
```

自检：

```bash
curl -s http://127.0.0.1:8731/health
curl -s http://127.0.0.1:8731/embed \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-embedding-0.6b","input":["今天吃什么","晚饭吃面"]}'
```

## 配置

`~/.dsh-wx/context.json`（权限 0600）：

```json
{
  "embedding": {
    "url": "http://127.0.0.1:8731",
    "model": "qwen3-embedding-0.6b",
    "dim": 1024,
    "timeoutMs": 15000
  }
}
```

- `dim` 必须是 1024；模型换了要同步改，旧向量缓存按 model+dim 分键，不会混用。
- `timeoutMs` 是单次 `/embed` 的超时（500–30000）。第一次批量嵌入可能要几秒；
  预热过的服务通常远低于这个值。不填则用 1500ms。
- 改完配置最多 60 秒生效（`vector.js` 有配置缓存）。

## 边界

- 侧车只读：不写台账、不写 `events.jsonl`、不记录请求正文。
- 检索不是记忆：只有 `growth_commit` 才能把一件事写进她的事件流。
- 服务挂了不算故障：退 A 档，`[dsh-wx] 向量检索：` 日志里会写原因。
