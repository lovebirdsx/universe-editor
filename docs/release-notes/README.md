# Release Notes（版本介绍）

每个已发布版本的**唯一正式来源**。应用内「更新说明」、下载站每版介绍页、GitHub Release 正文都由这里的 Markdown 确定性编译而来——不存在第二份手写文案。

```text
docs/release-notes/<version>.md         常规主稿：唯一正式来源（提交进 Git）
docs/release-notes/patches/<version>.md 轻量补丁记录：归并进所属主稿，不单独成篇
docs/release-notes/archive/*.md         已发布历史的冻结聚合（分节存档，只读）
      │  pnpm release:notes        确定性编译（无 AI / 无网络 / 无 wall-clock）
      ▼
apps/editor/resources/release-notes.json   运行时派生物（受 Git 管理）
      │  打包期同一快照
      ▼
安装包内 JSON ＋ apps/editor/release/release-notes/ 发布包（JSON、每版 HTML、索引、哈希清单）
      ▼
应用内版本介绍页 ／ 下载站首页与每版静态页 ／ GitHub Release 同源正文
```

Git 提交只是**整理事实与追溯变化的输入**（见 skill `generate-release-notes`），程序不会把提交列表收编成正文。

## 文件名

- 版本正文：`<version>.md`，如 `0.15.0.md`（**不带 `v` 前缀**，必须与 frontmatter `version` 一致）。
- 补丁记录：`patches/<version>.md`，如 `patches/0.15.2.md`（目录本身就表示「这是补丁」，frontmatter 里不再写类型字段）。
- 历史归档：`archive/*.md`，一个文件用分节标记装多个已发布版本（见「历史归档」）；新稿一律写在根目录，**不要**往归档里加内容。
- `README.md`、`_template.md`（根目录与 `patches/` 下）不是版本稿，永不进入发布产物。
- 一个版本只能有**一份记录**；重复版本号（含归档内重复分节）直接编译失败。

## frontmatter

扁平 `key: value`，只认下列字段（多余字段报错，不实现完整 YAML）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | `X.Y.Z`，与文件名一致 |
| `date` | 是（legacy 可缺） | 合法 `YYYY-MM-DD`，由作者明确填写；编译器**不会**用「今天」补历史日期 |
| `title` | 常规主稿是 | 短标题（列表与版本头展示）；补丁记录不写 |
| `summary` | 常规主稿是 | 一句话摘要；下载页列表用它；补丁记录不写 |
| `status` | 是 | `draft` 或 `reviewed`；**只有 reviewed 进发布产物** |
| `sourceFrom` | 发布前填 | 上次发布的 tag，如 `v0.14.9` |
| `sourceTo` | 发布前填 | 整理到的完整提交 SHA（供复核追溯，不用会移动的 `HEAD`） |
| `urgency` | 否 | `normal`（默认）或 `important`；见下文「紧急版本」 |
| `legacy` | 仅迁移稿 | `true` = 本轮从旧 JSON 归档的已发布内容 |

`sourceTo` 只作追溯线索，**不声称覆盖完整**；发版预检会打印 `上一个 tag..HEAD` 的完整提交清单（本次发布真正带出去的变更集）与 `sourceTo` 之后的提交，供复核，但不会用 `sourceTo === HEAD` 阻断发布。若之后又出现用户可见变化，必须补审并更新正文。

## 补丁记录（patches/）

一次修复发布**不占用一篇独立文章**：它是一份轻量记录，编译期归并进所属的常规主稿，读者在同一篇说明里就能看到修复内容。

- 落点 `docs/release-notes/patches/<version>.md`，只写简短修复条目；**不要求 `title` / `summary`**，正文从 `## ` 起（同样是「需要有人确认过这个版本说什么」，不是可以省略的草稿）。
- frontmatter 字段比主稿少，只有下列这些（多余字段报错）：

  | 字段 | 必填 | 说明 |
  | --- | --- | --- |
  | `version` | 是 | 本次安装版本 `X.Y.Z`，与文件名一致 |
  | `notesVersion` | 是 | 归并到的常规主稿版本（见下） |
  | `date` | 是 | 合法 `YYYY-MM-DD` |
  | `status` | 是 | `draft` 或 `reviewed`；**只有 reviewed 进发布产物** |
  | `sourceFrom` | 发布前填 | 上次发布的 tag，如 `v0.15.1` |
  | `sourceTo` | 发布前填 | 整理到的完整提交 SHA |
  | `urgency` | 否 | `normal`（默认）或 `important`；语义与主稿一致 |

- `notesVersion` 必须指向**同一 major/minor 系列里、该补丁之前最新的 reviewed 常规主稿**：禁止跨系列引用、引用补丁、前向/自引用，也不允许与该版本已有主稿冲突。这样补丁不会挂在已被新主稿取代的旧说明上，也不新增别名链。
- **归并 ≠ 只发这一条修复**。仓库是 trunk-based，补丁版仍然带出自上一个 tag 以来的**全部真实提交**；`sourceFrom` 必须等于紧邻的上一个 tag，发版预检照常打印完整提交清单供复核。是否归并只影响正文怎么呈现，不缩小发布范围。
- **编译归并**：reviewed 且版本不超过本次目标版本的补丁，被追加到所属主稿正文末尾的 `## vX.Y.Z 补丁修复` 段（按版本升序）。运行期 JSON、下载站历史目录**只有主稿条目**，条目 `version` 保持主稿版本，不生成独立补丁页面；补丁段里的 `doc:` 链接按**补丁自己的版本**固定，新加的文档不会错指到主稿更旧的 tag。
- 归并稿在运行期 JSON 里额外带 `bodySections: [{ version, offset }]`：`offset` 是该段在 `body` 内的字符起点（首段 0，后段是追加的补丁标题起点）。应用据此分段渲染、给每段的链接选回退版本，**不按标题文案识别**（标题改写、代码块里的假标题都影响不了切分）。无补丁的普通稿不带该字段，历史产物字节不变。
- **`notes/index.json` 每个安装版本都有条目**（普通与 important 一视同仁），补丁条目 `path` 指向主稿页并携带 `notesVersion` 供下载页归组——任何安装版本的紧急程度都能被客户端查到。
- 下载页按 `notesVersion` 归组：一篇主稿只展示一次，用主稿标题/摘要，展示组内**最新的适用安装版本**并链接到主稿页；最新归属不因 7 天时间窗消失。旧条目没有 `notesVersion` 时按自身版本处理。
- 仍需**用户明确审核后**把 `status` 改成 `reviewed`；`reviewed` 补丁记录必须有非空正文与 `sourceFrom` / `sourceTo`。
- **部署先行**：下载页的新归组逻辑随服务端版本发布（`scripts/server` 的 `SERVER_VERSION` 已 bump）。首次使用该展示前，先把服务端部署上去，否则老下载页不会按 `notesVersion` 归组。

## 紧急版本

`urgency: important` 是**唯一会改变客户端行为**的字段：它经 `notes/index.json` 传到客户端，编辑器发现该版本后会在 `update.mode` 为 `start` / `default` 时**后台静默下载**，下载完弹强提示，用户正常退出即安装。（`manual` / `none` 下编辑器根本不自动检查，用户手动跑「检查更新」发现时才给强提示。）所以：

- 只给「需要尽快升上去的修复」用（阻塞性 bug、数据损坏、安全事故）。**普通补丁一律留空**——每次都 important 等于每次都绕过用户的知情同意。
- 一次定稿：客户端按版本缓存该值，事后改标记对已检查过的客户端要等下次启动才生效。
- `legacy` 归档稿不得标记（历史版本不参与紧急更新），编译会报错。
- 它**不进**应用内运行时 JSON（`release-notes.json` 是随包安装的「当前版本」产物，拿不到新版本的信息），只进 `notes/index.json`。

## 正文

从二级标题开始（版本标题由消费端渲染），推荐结构：

```markdown
## 本次重点

一段话讲清这个版本最值得升级的地方，并给出操作入口（菜单路径 / 命令面板 / 文档链接）。

## <按场景或模块>

- 每条说清「用户会看到什么不同」；同一功能的多个提交合并成一条。

## 问题修复

## 升级注意事项
```

写作要求：

- 读者是**使用者**（策划 / 美术等），不是提交者：测试、CI、重构、依赖指针一律不写。
- 不写没有证据的性能 / 稳定性承诺，不按条数凑文案。
- 破坏性变化（默认值改了、旧行为不再支持）单独成节说明影响与迁移操作。
- 普通补丁可以很短；**仅内部维护的版本也要显式写明「无用户可见变更」**，不能以空正文代替确认。
- 每个功能介绍都写出**操作入口**（菜单 / 命令面板 / 设置项），让站外读者也能照做。
- 紧急发版时不要为了凑结构而拖时间：**只留 `summary` 与 `## 问题修复`** 是合法的正式稿，
  门禁要的是「有人确认过这个版本说什么」，不是篇幅。

### 支持的 Markdown 子集

标题、段落、列表、引用、代码块与行内代码、强调、链接、表格、分隔线——即应用内渲染器与下载站渲染器都稳定支持的子集。**不支持图片、任意 HTML、嵌入脚本、引用式链接、脚注**；出现即编译失败（明确报错，不静默丢弃）。

**只有显式 scheme 才会成链**：写 `https://example.com` 会渲染成链接，`example.com`、`CLAUDE.md`、`install.sh` 这类裸文本（以及裸邮箱）保持文字——与应用内渲染一致，避免在公开页面上编造出指向真实域名的外链。

### 链接

| 写法 | 含义 | 应用内 | 站外（下载站 / GitHub） |
| --- | --- | --- | --- |
| `doc:<docId>` | 随包用户文档（如 `doc:getting-started/interface-tour`） | 离线打开文档；当前版本已无该文档时提示并给出对应 `v<version>` 的 GitHub 链接 | 改写为 `blob/v<version>/docs/user/zh-CN/<docId>.md` |
| `command:<commandId>` | 无副作用的导航命令（打开设置 / 快捷键 / 主题…） | 点击执行（显式白名单） | 改写为「在编辑器中：…」文字，不产生浏览器无法执行的链接 |
| `https://…` | 公开网页 | 交给系统浏览器 | 原样 |
| `#<标题 slug>` | 本稿内的标题锚点 | 页内跳转 | 页内跳转 |

- 白名单与规则单一来源：`apps/editor/src/shared/releaseNotes/linkPolicy.json`（构建期校验与运行期守卫读同一份）。
- 其它协议（`javascript:` / `data:` / `file:` / 协议相对 URL）与相对路径链接一律编译失败——**不回落成文件打开**。
- `doc:` 的 docId 是 `docs/user/<locale>/` 下的相对路径去 `.md`；禁绝对路径、`..`、编码绕过与跨文档片段。

**锚点写标题 slug**：小写、空白转 `-`、去标点、CJK 原样保留——`## 子结构：ITalkItem` 的锚点是 `#子结构italkitem`（与应用内标题的 slug 同一规则）。锚点必须命中**本稿内**的标题，否则编译失败；同一稿里出现重复 slug 时，被引用的那个也要唯一。

## 审阅流程

1. 用 skill `generate-release-notes` 按「待发布版本 + 基准 tag + 目标 SHA」整理，产出 `docs/release-notes/<version>.md`，`status: draft`。修复发布产出 `docs/release-notes/patches/<version>.md`（写明 `notesVersion`），同样是 `status: draft`。
2. 在对话中逐条复核证据（功能是否真的在发布树里、菜单/命令/文档是否可用）。
3. **用户明确确认后**才把 `status` 改成 `reviewed`。提交记录或字段本身不是可验证的「人类签名」。

正式稿必须在发版前提交（发版预检要求干净工作区）。

## 编译与校验

```bash
pnpm release:notes -- --version 0.15.0   # 编译截至该版本的 reviewed 稿（含补丁归并）→ 运行时 JSON（不改源文件）
pnpm release:notes:check                 # 无写入校验：全部文档语法 + 派生物一致性（接入 pnpm check 与 CI）
```

- 发版（`pnpm release`）在**改版本号之前**要求目标版本已存在 `reviewed` 正式稿或 `reviewed` 补丁记录，否则直接失败。
- 缺稿 / draft / 空新稿 / 重复版本 / 非法日期 / 坏链接 / 不支持语法一律 fail-closed。
- 补丁归属错误（`notesVersion` 缺失 / 跨系列 / 前向引用 / 指向非最新主稿 / 与主稿版本冲突）同样编译失败。
- 未来版本与 draft 不得混入较早版本的发布产物。
- `--resume` 与 `--upload-only` 只做一致性校验（重编译必须逐字节相同），不会重写正文，也不会产生新提交。主稿与补丁记录都纳入打包快照的来源摘要，任何一个源文件改动都会阻断复用旧快照。

## 历史归档（legacy）

`legacy: true` 是本轮把旧 `apps/editor/resources/release-notes.json` 机械转换过来的标记：

- 保留原版本号、原日期、原分组与条目、空历史，逐字转义（不把旧文本变成新链接或格式）。
- 按「原样归档」处理并标为 `reviewed`——这不是重新编辑审核。
- 只允许这批**迁移时已发布**的版本豁免「摘要 / 范围 / 非空正文」规则；**新版本不得使用 `legacy` 绕过校验**（编译期按固定边界校验）。

这些稿子不再一版一文件，而是合并进 `docs/release-notes/archive/legacy.md`：每个版本一节，节与节之间是一行独立的分节标记，节内就是原来的整份 Markdown（含 frontmatter）：

```text
<!-- release-note: 0.1.3 -->
---
version: 0.1.3
status: reviewed
legacy: true
---

## 新功能

- 条目…
```

- **只读**：归档由生成器产出、按字节冻结；日常只在根目录写新稿。要改历史正文，先想清楚——`--check` 会立刻发现与迁移前 JSON 不一致。
- 归档分节必须是 `legacy: true`；把新稿塞进归档会编译失败。
- 编译器按分节解析，报错行号是**归档文件里的绝对行号**（`archive/legacy.md（0.1.3 分节）:12: …`）。
- 迁移工具（一次性，保留用于校验）：`node scripts/release/release-notes/migrate-legacy.mjs`，`--dry-run` 预览、`--check` 校验整份归档仍与冻结的迁移前 JSON 夹具逐版本、逐条目等价。
