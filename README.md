# 大肥鱼工作区

`src/dsh-fish` 与 `src/dsh-wx` 从 2026-10-30 插件交接包恢复，为后续修改的源码基线；尚未部署到 SSD 或运行中的 DSH。原始安装包保留在本机。

Git 跟踪源码、脚本和技术文档。屋子、聊天记录、凭据、日志、安装包、磁盘镜像与备份仅保留本地；Git 不代替这些数据的备份。历史文档含本机路径及账号标识，公开仓库前需要按公开范围审阅。

```powershell
python scripts/diagnose-history.py
node --test   # 在 src/dsh-fish 目录执行
node src/dsh-wx/selftest.mjs
```

历史诊断输出到被忽略的 `reports/history-diagnosis.json`，不包含消息正文或凭据。运行时诊断：在 Pi 上以运行 DSH 的用户执行 `bash scripts/diagnose-runtime.sh`；只检查文件存在性、服务状态和版本，不发送消息、不启动服务、不输出配置内容。

安装状态以 `离线安装记录-2026-11-01.md` 为准，旧交接中的盘号不可直接复用。不得拼接 WSL 删除命令；会话归档使用 `scripts/rm-session.sh`。
