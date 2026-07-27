---
name: extension-system-progress
description: VSCode 式外部插件系统 + Git 扩展已全部落地（Phase 0–6 + 2026-07 单 host 重构）；目录知识与非显然决策索引
metadata: 
  node_type: memory
  type: project
  originSessionId: b2559863-e8e1-47c5-9ee4-b32064419766
---

VSCode 式外部插件系统 + Git 扩展已全部落地：Phase 0–6（脚手架/stdio RPC/manifest 懒激活/配置菜单键位/SCM API/Git 扩展/外部加载）+ 2026-07 重构为**单 host + Workspace Trust**。目录知识：`packages/extension-host/CLAUDE.md`（运行时）、`apps/editor/src/main/services/extensionManagement/CLAUDE.md`（分发链路）；实施史见 git。

非显然决策 hook（细节见上述 CLAUDE.md 与 git）：
1. RPC 对端是 renderer 不是 main（main 只搬字节，同 ACP）。
2. stdio 分帧用换行分隔 UTF-8 帧不用 base64（JSON 转义裸换行）。
3. extension-api 用 globalThis bridge 注入而非 ESM loader hook；enum 用普通 enum 非 const（isolatedModules 报 TS2748）。
4. SCM 视图是内置宿主组件，扩展只注册 provider（对标 VSCode，不走 manifest views 翻译）。
5. workspace 路径经 env（`UNIVERSE_WORKSPACE_ROOT`）传给 host，静态、切换需重启 host。
6. git 全程 CLI（spawn argv 数组不拼 shell）；porcelain v2 rename 条目占两个 NUL 字段。
7. 按安装来源分双进程是错误路线（eslint 在 restricted 拿不到 languages 通道），已塌成单 host + 激活期信任门控：撤销=重启 host，授予=动态 replay 激活事件，built-in 恒豁免。
