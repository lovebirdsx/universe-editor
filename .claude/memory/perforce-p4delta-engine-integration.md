---
name: perforce-p4delta-engine-integration
description: perforce 扩展接入 p4delta 可替换引擎（--json 契约）的进展与三处最易出事的地方
metadata:
  type: project
---

2026-10-04：把内部 Rust CLI **p4delta（δ）**接成 `extensions/perforce` 的可替换引擎，两个仓库都改了（编辑器分支 `wsl-task1`；δ 在自己的 `p4delta` worktree、分支 `task1`。**两侧均未提交**）。δ 侧新增 `--json`（契约 = δ 仓库自己的 `json-contract` 文档，单一真相）；编辑器侧接扫描 / 窄查 / 三个写操作（`reconcile`/`reconcileInto`/`revertReconcile`），`sync` 系**刻意不接**（δ 的 `--sync` 是 `p4 sync -f` 语义，会覆盖未打开文件上的本地改动 = 数据损失）。装了就用的开关 = `perforce.p4delta.enabled` / `perforce.p4delta.path`。

**Why:** 「可替换引擎」的失败模式集中在**回退路径**与**消费外部记录流**两处，且都是静默的——不会报错，只会让面板显示与实际不符，或在最坏情况下删掉用户明确排除的目录。

**How to apply:** 接第二个引擎（或改这套接线）时，先建三条不变量，再动手：

1. **回退时的输入形态假设会变**。δ 生效时命令层**不 carve**（用 δ 自己的 `-<entry>/...` 排除项），而原生 **必须** carve。所以「δ 读不了这批 spec → 退回原生」这条安全网本身会把**未 carve 的 spec** 喂给原生 = 排除项失效 = `p4 clean` 删掉被排除子树里的本地改动（不可逆）。把关点只能在 `extension.ts`（那里才有未转义的原始路径、才能 carve）；client 侧的退回原生只保证「慢」，不保证「对」。含 p4 filespec 元字符（`@ # * % ;`）的路径一律走 carve。
2. **消费外部进程的记录流，必须正向校验「这一轮回答的是不是我问的问题」**。δ 的 `mode` 与 `applied` 曾被完全忽略：一轮 `mode:"clean"` 的记录 + `ok:true` 会让 `toReconcileFiles` 静默丢掉全部记录 → `files=[]` → 扫描**清空漂移集并写 24h checkpoint**（把失败读成干净）。写操作同理：`ok:true` 但 `applied:false` 会被当成「已收集」。契约保证的字段要**主动核对**，不能只当透明信封。
3. **`handoff`（转交原生 p4 的文件）必须让扫描也拒绝下结论**。δ 违约在 open 预演里发了 handoff → 那条路径被当「无漂移」清掉。窄查早已判 handoff，扫描侧漏了半年——两条路径对同一形状给出相反答案本身就是缺陷。

另：δ 的 `--json` 输出里 **`clientFile` 是 client 语法**（`//<client>/<rel>`），只有原生 reconcile 的记录回本地路径；`depotFile` 必填含新增文件；**没有 `kind:"summary"` 就等于「没有结论」**（崩溃/被杀天然没有）——这是整个回退阶梯的地基。e2e 用**委托式** fake（`e2e/fixtures/fake-p4delta.mjs` 解析 δ 参数后 spawn `fake-p4.mjs` 再翻译回 JSONL，两个 fake 共享同一份 state JSON），故障档走 `UNIVERSE_P4DELTA_FAKE_FAIL`。相关代码约定见 `extensions/perforce/docs/reconcile.md`。
