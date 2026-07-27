---
name: largefile-reveal-dirtydiff-vscode-parity
description: 大文件治理十轮教训索引——reveal 事件化/行级 diff/增量同步/tsserver OOM 化/IPC 分片/DTO 去 text/切tab看门狗
metadata: 
  node_type: memory
  type: project
  originSessionId: ae0fd3b3-d185-4df3-9aff-7647cb31b036
---

34 万行 `index.d.ts` 暴露的十轮问题与修法均已落地（2026-07），实现细节 git 可查，此处只留通用教训：

**Why:** ① 定时轮询等异步挂载在大文件上必然超窗——reveal 是 model 就绪的后继动作，走事件（`waitForFileEditor`/`revealSelectionInInput`）；② 主线程全文字符串 diff 无豁免必然卡顿——`ThrottledDelayer` + 大小豁免 + 行级 diff（见 [[linediff-myers-perf]]）；③ 全文文档同步每键都是灾难——Monaco deltas 按 rangeOffset 降序转 LSP contentChanges 增量同步，tsserver 设 `maxTsServerMemory`；④ 多余的全文 didOpen 只有靠「恰好 N 次」日志断言暴露，功能测试全绿也抓不到——连接代际去重；⑤ 字符串流式切帧必须带分片累积器，`+=`+全量扫描在多 MB 帧上是 O(n²)；⑥ **任何挂在 activeEditor 变化上的反应都不得携带/构造全文**（DTO 带 text、`getValue()` 后正则扫全文都算）——每次切 tab 都重付一次；⑦ 跨 IPC 的错误 stack 是 synthetic，renderer 帧不可信。

**How to apply:** 「打开后定位/聚焦」一律走 `revealSelectionInInput`/`waitForFileEditor`（有宿主 store 就传，防泄漏门禁），禁止再写 rAF+setTimeout 轮询；诊断 LSP/tsserver 用最小 stdio 复现脚本（注意 cli.mjs 正斜杠路径在 Windows 静默回退旧 TS，传反斜杠）；性能修复验证用「日志计数断言」临时 spec；用户报「切 tab 卡」先要看门狗 `tabSwitchPerf.log` warn 行（long task + 相位归因），新嫌疑代码包一层 `recordTabSwitchPhase` 即自动进报告；e2e 依赖新 workspace 包时检查 apps/editor devDependencies 是否有边（否则 turbo 不重建，跑 stale bundle）。
