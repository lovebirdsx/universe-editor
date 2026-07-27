---
name: agent-binary-silent-download-e2e-fix
description: "e2e \"Failed to start agent\" 噪音 + Worker teardown timeout 的根因链：misrouted binary guard→背景真下载→tsserver 孤儿持管道；修法=allowDownload 网关+探针门禁+优雅级联+fixture 扫孤儿"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d49b0d2-fa51-4982-b374-9f7b6f7f7797
---

e2e agent 通知噪音与 `Worker teardown timeout` 已修（全链路：binary guard 误路由 → silent 通知 → 背景 prefetch 真下载 → tsserver 孤儿）。细节 git 可查，非显然 hook：

1. 背景探测走 `connect(agentId, {silent})` + `allowDownload: !silent` 网关（cache miss 时快速失败不碰网络）；`resolve()` 的 `_inflight` key 按 allowDownload 加后缀，防 fast-fail promise 被真实下载调用方误复用。守卫按 `agentId` 判（曾按 `spec.runAsNode` 把 codex 误路由进 claude 分支，报错张冠李戴）。
2. `AgentBinaryPrefetchContribution`（Eventually 相位）用 e2e 探针门禁（`window[E2E_PROBE_ENABLED_KEY]`）跳过 `_prefetch()` 真下载，保留纯本地 `_cleanup()`。
3. 判据：`app.close()` 卡住 = 子进程孤儿持管道不放，"全 passed + 位置随机"**不足以**判环境噪音，必须实测残留进程（曾因此把真回归误判为 Windows 噪音）。
4. tsserver 孤儿链：vendored CLI 只在优雅退出（stdin EOF / 父死 watchdog）时经 `process.on('exit')` 回收 tsserver；`taskkill /T /F` 硬杀跳过 exit hook 还把慢启动的 semantic tsserver 甩出 PID 快照 → 孤儿。修法=优雅级联（`lspClient.dispose()` 改 `stdin.end()`、`stopAll()` await exit），treeKill 仅作 backstop。
5. Playwright `app.close()` 直接 SIGKILL main，in-app `before-quit`/`will-quit` 钩子在 e2e 是**死代码**；只能靠 fixture 层 `killOrphanedLanguageServers()` 扫「父已死」孤儿（`forceKillTree` 按后代树扫不到已脱离的 tsserver）。

相关：[[codex-session-skills-scan-slow]]；裸 `electron.launch` 环境 flake 见 skill `fix-ci-e2e-flake` 案例 28；treeKill 链路见 `packages/extension-host/CLAUDE.md`。
