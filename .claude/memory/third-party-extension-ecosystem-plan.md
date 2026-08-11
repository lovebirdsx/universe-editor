---
name: third-party-extension-ecosystem-plan
description: 第三方插件生态计划（docs/plan/third-party-extension-ecosystem-plan/），Phase A 已落地；四个方向性决策已由用户拍板
metadata: 
  node_type: memory
  type: project
  originSessionId: a0b85385-def0-4754-a72c-a0ab0a8bea88
  modified: 2026-08-10T01:59:55.094Z
---

第三方插件生态（对标 VSCode 外部开发者体验）计划于 2026-07-29 完成规划，文档在 `docs/plan/third-party-extension-ecosystem-plan/`（README + 01–06）。核心判断：编辑器侧"跑扩展+装扩展"两条链路已就绪（见 [[extension-system-progress]]），缺口全在"仓库外开发者"一侧——SDK 未发 npm、无脚手架/CLI、无 `--extension-development-path` 开发模式、无自助发布通道、无对外文档。

**Phase A（SDK 对外化）已于 2026-07-29 落地**（pnpm check 全绿 + 仓库外 tarball 三验通过）：
- 发布集合三件套：`extension-api@0.7.0` + `extension-manifest@0.1.0`（🆕）+ `extension-packaging@0.1.0`，均 Apache-2.0。**关键修订**：extensions-common 运行时依赖不可发布的 platform（stdioProtocol 的 Disposable/Emitter + rpc/aiWire 的类型引用），无法按计划整包发布——作者面 5 模块（activation/manifest/manifest-schema/semver/categories）物理迁入新包 `@universe-editor/extension-manifest`，extensions-common 依赖并 re-export（仓库内消费方零改动），packaging 改依赖新包。
- 已验证：`pnpm pack`/`publish` 会把 `workspace:*`→精确版本、`catalog:`→版本区间；`files: ["dist", "!dist/__tests__"]` 否定模式排除测试；三包 d.ts 自包含（仓库外 strict tsc 无额外 @types 通过）。
- 落点：发布手册 `docs/development/publishing-sdk.md`；versioning 草稿 `docs/extension-dev/zh-CN/versioning.md`；内网 tarball 托管 `pnpm gallery:publish-sdk`（server 静态服务 `{base}gallery/sdk/` 零改动）；宿主 API 版本经 `--version` 与 About 对话框可查（IVersionInfo.extensionApi）。
- **待办**：npm org `@universe-editor` 注册是运营事项，注册后按手册手动 `pnpm publish`（先手动后 CI）。

**2026-08-11 修订**：网页自助注册改**审批制**（决策 2 联动修订）——注册落 `status: 'pending'`，publish/unpublish 403 直至管理员在最小审批页 `gallery/admin`（独立管理令牌 `--admin-token-file`，未配置 fail-closed 503）批准；被拒绝 publisher 的 token 一律 401 与无效 token 不可区分；whoami 透出 status（`uex whoami` 新命令查进度）；运维通道 `token.mjs issue` 直接 active。完整管理台仍封印在 Phase F（范围缩减为运营视角完整版）。详见 `docs/development/marketplace-server.md`「审批管理」节。

用户已拍板的四个方向性决策（后续实施勿再议）：
1. **生态范围**：先内部后公开——架构按公开设计（认证/签名留接口不实现），公开阶段前置项全部登记在计划 06、不提前做。
2. **发布通路**：自助 token 发布——**2026-08-10 修订**：内部阶段即为双通道（运维 `gallery:token` 签发 + 网页注册页 `GET {base}gallery/register` / `POST gallery/api/register`，无登录态一次性表单，注册即发 token，仅 token 模型无密码/session）；token 自服务页/邮箱验证/防仿冒仍属公开阶段。同日落地**服务端发布时签名**（server `--signing-key-file`/`UE_SERVER_SIGNING_KEY_FILE` + keyId 默认 market-v1，publish 流水线 signVsix 写 sha256+signature；未配密钥 publish 503），打通 uex publish → 编辑器 fail-closed 验签可装的闭环。uex 包已 npm 发布就绪（LICENSE/README/pack 清单验证过），实际 npm org 注册与 publish 由用户手动执行。
3. **调试体验**：完整对标 VSCode——`--extension-development-path` + `--inspect-extensions` 断点 + `restartExtensionHost` 命令（计划 02）。
4. **VSCode 兼容**：移植指南 + API 对齐，**不做 vscode shim、不承诺兼容**（计划 05 §3）。

次级决策（计划 README §1 决策 5–9，随方案给出、可复议）：API 包发公开 npm `@universe-editor` scope；CLI 双包 `create-extension` + `uex`（bin `uex`，对齐 vsce 命名）；开发宿主 userData 默认隔离（storage 是 JSON 文件，双实例并发写会互相覆盖）；0.x 不建 proposed API 机制；对外文档 `docs/extension-dev/zh-CN/` 随仓库。

**Why**: 这些决策界定了 Phase A–F 的范围与顺序（A SDK✅ / B DX / C 工具链 / D 发布后端 / E 文档样例 / F 公开登记），实施会话不了解背景容易重新发明或做过头（如提前建注册系统、或把 extensions-common 整包发布导致外部解析失败）。
**How to apply**: 实施任一 Phase 前先读对应章节；改方向先改计划 README 决策表再动码。注意计划里的红线：token 文件绝不进 gallery 静态托管目录、`UNIVERSE_USER_EXTENSIONS_DIR`（e2e 替换语义）与 dev path（附加语义）两通道不合并、对外 UI/文档不得宣称扩展已沙箱。
