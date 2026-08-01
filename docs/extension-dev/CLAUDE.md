# docs/extension-dev/CLAUDE.md

第三方扩展作者文档册（对应 `docs/user/` 编辑器用户、`docs/development/` 本仓库开发者——三套受众互链不互抄）。随 `pnpm docs:check` 校验死链（`scripts/check-doc-links.mjs` 多根扫描）。

## 写作纪律

- **如实原则（本册第一红线）**：贡献点、API、激活事件三个"清单型"章节只写宿主当前真实支持的集合，每篇标注"以 API x.y 为准"。真相源：
  - 贡献点 → `apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts`（真实处理的分支 + `MENU_ID_BY_KEY`）
  - API 表面 → `packages/extension-api/src/index.ts` 等 d.ts（JSDoc 是 API 的第一参考，文档只做 namespace 级导览，**不逐方法抄写**——抄了必漂移）
  - 激活事件 → `packages/extension-api/COMPATIBILITY.md` 清单表
- **安全措辞红线**：与 `docs/user/zh-CN/customization/extensions.md` 的"关于安全边界"一节逐字对齐——扩展以"接近编辑器本身的权限"运行、编辑器"不会把扩展关进沙箱"。**任何页面不得出现"沙箱隔离"式宣称**（webview 只能称"受限的内嵌页面，非强沙箱"）。
- **缺失能力如实列**：`migration-from-vscode.md` 的对照表同时是 API 路线图输入，缺失项标"计划中/无计划/用 X 绕过"，不许藏着。
- 风格：`zh-CN` 为基准语言（目录预留 `<locale>/` 层级）；无 frontmatter、H1 + `>` 引用块导读、中文行文、代码标识符英文、互链相对路径 + `.md`。

## 版本跟进（API bump 时的文档义务）

`extension-api` 每次 minor 发布，以下三处跟着过一遍（属 `COMPATIBILITY.md` 破坏性变更流程的一环）：

1. `migration-from-vscode.md` 的 API 对照表
2. 各篇头部的"以 API x.y 为准"标注
3. `samples/hello-world` 的 `engines.universe` 与依赖版本（重新 scaffold 同步——CI `external-consumer-smoke` 的漂移检查会强制暴露，见 `samples/hello-world/README.md` "Drift check"）

新 API 进 `extension-api` 时必须带 JSDoc（含语义与边界）——JSDoc 是对外文档，不是内部注释。
