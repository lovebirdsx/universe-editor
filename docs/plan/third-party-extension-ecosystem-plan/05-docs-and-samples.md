# 05 — 对外文档与样例：第三方开发者的学习面

> Phase E。目标：一个没接触过本项目的开发者，只靠文档从零走通 create → 调试 → package → publish；文档接入 `pnpm docs:check` 防死链。
> 对标：code.visualstudio.com/api + microsoft/vscode-extension-samples。
> 定位边界：`docs/user/`（编辑器用户）、`docs/development/`（本仓库开发者）、**`docs/extension-dev/`（第三方扩展作者，本阶段新建）**——三个受众三套文档，互链不互抄。

## 1. 目录结构（对齐 `docs/user/zh-CN` 惯例）

```
docs/extension-dev/zh-CN/
  README.md                 导览 + 一图流开发者旅程（create→dev→package→publish）
  getting-started.md        全流程实操：npm create → npm run watch → uex dev → 改代码重载
                            → uex package → 从 VSIX 安装自测 → uex login/publish
  extension-anatomy.md      manifest 逐字段（name/publisher/engines.universe/main/files/
                            activationEvents/contributes/capabilities.untrustedWorkspaces）、
                            激活生命周期（activate/deactivate/懒激活）、ExtensionContext
  contribution-points.md    贡献点参考：commands/menus/submenus/keybindings/configuration/
                            jsonValidation/customEditors —— 以 ExtensionPointTranslator 实际
                            支持的集合为准如实生成，宿主没支持的一个不写
  api/README.md             API 参考：namespace 导览（commands/window/workspace/languages/
                            scm/ai/timeline/webview）+ 每个 namespace 一段定位与最小示例，
                            细节指向 d.ts 的 JSDoc（见 §2）
  debugging.md              uex dev --inspect / launch.json attach / --inspect-brk /
                            sourcemap 要求 / host 重启后重新 attach / 日志（Output 通道）
  webview-guide.md          自定义编辑器与 webview：asWebviewUri/localResourceRoots/CSP，
                            从 pdf 扩展提炼（含"预览器出 UI 但空内容 = 漏文档目录"等实坑）
  language-guide.md         语言特性：languages namespace 注册 provider；进阶"扩展内自
                            spawn 语言服务器"模式（从 eslint/typescript 提炼）
  versioning.md             engines.universe 协商语义（01 §4 草稿落位）：API 版本≠编辑器
                            版本、推荐区间写法、0.x 破坏性变更政策、宿主 API 版本查询方式
  publishing.md             发布规范：token 获取（内部阶段找运维签发）、uex login/publish、
                            版本不可变、files 白名单、icon/README/CHANGELOG 要求、下架流程
  migration-from-vscode.md  VSCode 扩展移植指南（§3）
  security-and-trust.md     诚实边界：扩展权限"接近编辑器本身"（红线措辞与用户文档一致，
                            不得宣称沙箱）、untrustedWorkspaces 声明怎么写、发布者责任
```

- 全部内部链接接入 `pnpm docs:check`（既有校验器覆盖新目录即可，确认其扫描根包含 `docs/extension-dev`）。
- **如实原则**：贡献点、API、激活事件三个"清单型"章节只写宿主当前真实支持的集合（真相源分别是 `ExtensionPointTranslator`、extension-api d.ts、`COMPATIBILITY.md` 激活事件表）；每个清单标注"以 API x.y 为准"。宁可清单短，不可清单虚。

## 2. API 参考策略：JSDoc 即真相，typedoc 后置

- **主策略**：extension-api 的 d.ts JSDoc 已有相当质量（头注释、每接口说明），作者的第一参考就是编辑器里的类型提示。`api/README.md` 只做 namespace 级导览 + 示例，不逐方法抄写——逐方法文档与 d.ts 必然漂移，漂移的文档比没有更糟。
- **typedoc 自动生成**（d.ts → HTML/MD）登记为增强：等 API 面进入 1.0 冻结期再上——0.x 高频演进期自动生成产物的 churn 不值得。
- 由此对 extension-api 的反向要求（回灌 01/Phase A 的日常纪律）：**新增 API 必须带 JSDoc（含 `@example`）才能过 review**——JSDoc 从"内部注释"升格为"对外文档"。

## 3. VSCode 移植指南（决策 4 的落点）

`migration-from-vscode.md` 三段式：

1. **机械替换**：`import * as vscode from 'vscode'` → `import * as universe from '@universe-editor/extension-api'`；manifest `engines.vscode` → `engines.universe`（语义变化：API 版本而非编辑器版本，链 versioning.md）；`.vscodeignore` → `files` 白名单。
2. **API 对照表**：逐 namespace 列三栏——VSCode API / Universe 等价物 / 状态（`对齐`｜`语义差异（注释差异点）`｜`缺失`）。**缺失清单如实列**（当前明确没有的大块：TreeView、FileSystemWatcher、terminal、tasks、debug、notebook、authentication…），每项标注"计划中/无计划/用 X 绕过"。这张表同时是我们自己的 API 路线图输入——移植者的高频受阻点就是下一个该补的 API。
3. **实战案例**：pdf 扩展移植记（改 import、砍 `createFileSystemWatcher` 自动重载、`localResourceRoots` 补文档目录），给移植者一个"多大工作量"的真实锚点。

维护约定：extension-api 每次 minor 发布，对照表跟着过一遍（写进 COMPATIBILITY.md 的破坏性变更流程第 5 步）。

## 4. 外部形态样例 `samples/hello-world`

- **形态**：仓库新顶层目录 `samples/`，**不进 pnpm workspace globs**（与 `extensions-external` 同理但更进一步）——依赖写**真实 npm 版本号**（`"@universe-editor/extension-api": "^0.7.0"`），无任何 workspace/createRequire hack，`git clone` 单拎这个目录出去就能构建。它就是"仓库外开发者项目"在仓库里的替身。
- **产生方式**：用 create-extension 模板生成后提交固化——它同时验证模板产物质量；模板改版时重新生成同步（脚手架单测里加"模板生成物 ≡ samples 骨架"的漂移检查，或干脆由 CI 重生成比对）。
- **数量**：MVP 只放 `hello-world`（basic 模板产物 + 少量真实注释）。webview 等进阶场景**不复制样例**，文档直接链 `extensions-external/pdf` 的 `src/`（标注：src 可参考、构建脚本是仓库内形态勿照抄）。
- 公开阶段若要独立 samples 仓库（对标 vscode-extension-samples），从 `samples/` 平移即可（登记 06）。

## 5. CI：外部消费者冒烟（防"仓库内能跑、仓库外必挂"）

新增 job `external-consumer-smoke`（承接 03 §5 的模板防腐，合并为一个）：

```
① pnpm --filter extension-api --filter extensions-common --filter extension-packaging
       --filter uex --filter create-extension exec pnpm pack     # 本地 tgz，不依赖已发布
② 临时目录：create-extension 模板生成 + samples/hello-world 各一份
③ npm i <tgz...>（消费本地包，其余依赖走真实 registry）
④ npm run build → uex package → readVsixManifest 验包结构
```

- 触发：上述五包或模板/样例变更时跑（turbo 过滤），外加 nightly 全量——npm pack 路径覆盖了 01 §7 说的"hoist 掩盖依赖缺失"一类问题，这是本计划里**唯一**能在合入前抓住这类回归的自动化。
- Windows + ubuntu 双跑（`uex dev` 定位逻辑除外——它需要装好的编辑器，标记 skip，靠 e2e 侧覆盖）。

## 6. 验证（Phase E 完成标准）

- `pnpm docs:check` 通过（新目录纳入）；`external-consumer-smoke` 在 CI 绿。
- **Dogfood 终验**：请一位未参与实施的同事，只给一个 URL（docs/extension-dev/zh-CN/README.md），从零走通 create→调试断点→package→publish→在自己编辑器里搜到并安装。过程中每一次卡壳/查源码/问人都记录为文档缺陷，修完才算 Phase E 完成——这是整个计划的最终验收，前面四个 Phase 的对外表面质量在这一步统一现形。

## 7. 坑与注意

- **三套文档的边界纪律**：用户侧"怎么装扩展"（docs/user）与作者侧"怎么发扩展"（docs/extension-dev）会互相引用，只链不抄——抄一段就多一处漂移点。`docs:check` 管死链，管不了内容漂移，靠 review 纪律。
- **security-and-trust.md 的措辞红线**：与 `docs/user/zh-CN/customization/extensions.md` 的既有口径（"接近编辑器本身的权限"）逐字对齐，**不得出现"沙箱/隔离"表述**——这条红线在两份 CLAUDE.md 里反复出现，对外文档同样适用且更敏感。
- **samples 的依赖版本会过期**：`^0.7.0` 在 API bump 后要跟——把 samples 的 engines/依赖更新并入 COMPATIBILITY.md 变更流程（与 §3 对照表同一步），否则半年后 samples 就是负资产。
- 文档语言：内部阶段只写 zh-CN（对齐决策 9）；目录结构预留 `<locale>/` 层级，英文化时平移不重构。
