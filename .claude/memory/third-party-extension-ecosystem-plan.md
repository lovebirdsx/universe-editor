---
name: third-party-extension-ecosystem-plan
description: 第三方插件生态计划已立（docs/plan/third-party-extension-ecosystem-plan/），四个方向性决策已由用户拍板
metadata: 
  node_type: memory
  type: project
  originSessionId: a0b85385-def0-4754-a72c-a0ab0a8bea88
---

第三方插件生态（对标 VSCode 外部开发者体验）计划于 2026-07-29 完成规划，文档在 `docs/plan/third-party-extension-ecosystem-plan/`（README + 01–06），尚未实施。核心判断：编辑器侧"跑扩展+装扩展"两条链路已就绪（见 [[extension-system-progress]]），缺口全在"仓库外开发者"一侧——SDK 未发 npm、无脚手架/CLI、无 `--extension-development-path` 开发模式、无自助发布通道、无对外文档。

用户已拍板的四个方向性决策（后续实施勿再议）：
1. **生态范围**：先内部后公开——架构按公开设计（认证/签名留接口不实现），公开阶段前置项全部登记在计划 06、不提前做。
2. **发布通路**：自助 token 发布，两步走——内部阶段运维脚本签发 token + 服务端认证 publish API（计划 04），自助注册属公开阶段。
3. **调试体验**：完整对标 VSCode——`--extension-development-path` + `--inspect-extensions` 断点 + `restartExtensionHost` 命令（计划 02）。
4. **VSCode 兼容**：移植指南 + API 对齐，**不做 vscode shim、不承诺兼容**（计划 05 §3）。

次级决策（计划 README §1 决策 5–9，随方案给出、可复议）：API 包发公开 npm `@universe-editor` scope；CLI 双包 `create-extension` + `uex`（bin `uex`，对齐 vsce 命名）；开发宿主 userData 默认隔离（storage 是 JSON 文件，双实例并发写会互相覆盖）；0.x 不建 proposed API 机制；对外文档 `docs/extension-dev/zh-CN/` 随仓库。

**Why**: 这些决策界定了 Phase A–F 的范围与顺序（A SDK / B DX / C 工具链 / D 发布后端 / E 文档样例 / F 公开登记），实施会话不了解背景容易重新发明或做过头（如提前建注册系统）。
**How to apply**: 实施任一 Phase 前先读对应章节；改方向先改计划 README 决策表再动码。注意计划里的红线：token 文件绝不进 gallery 静态托管目录、`UNIVERSE_USER_EXTENSIONS_DIR`（e2e 替换语义）与 dev path（附加语义）两通道不合并、对外 UI/文档不得宣称扩展已沙箱。
