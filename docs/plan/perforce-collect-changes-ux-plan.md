# Perforce「收集修改」体验优化设计方案

> 目标:让 `extensions/perforce` 的「把修改收集进来准备提交」这条链路,达到与内置 Git 扩展对等的易用度。本方案**只做设计,聚焦交互设计、信息呈现与操作流程,不涉及编码**;必要处向 git 操作靠拢。
>
> 前置阅读:整体架构见 `docs/plan/perforce-scm-plugin-plan.md`(§2 模型差异、host 泛化、密钥红线)与 skill `extend-perforce-plugin`。本方案是它的**体验增量**,不重复其架构结论。

---

## 1. 问题诊断:为什么 p4 的「收集修改」不如 git 易用

### 1.1 一句话根因

git 面板 = **磁盘真相**(`git status`,改了就显示,再由你决定 stage);当前 p4 面板 = **服务器 `p4 opened` 列表**(只有先 `p4 edit` 签出的文件才出现)。这个根本差异,叠加"无文件监视 + 签出入口缺失",让"把修改收集进来"这一步在 p4 里处处是死结。

### 1.2 现状链路(代码事实)

- `client.ts` `_doRefresh()` 只跑 `p4 opened` + `p4 changes -s pending`,面板只反映**已签出**的文件。
- `package.json` 里 `perforce.edit` / `add` / `delete` 三个命令**没有任何 `menus` 项**——只能从命令面板触发;而未签出文件根本不在面板里,想点也点不到 → **死结**。
- 无 FS watcher,只有"操作后 `refresh()` + 可选轮询";`perforce.refreshInterval` 默认 `0`(关),窗口切回来也不刷新 → 编辑器外的改动永不反映。
- 唯一的"自动收集"是 `autoEdit`(改文件即 `p4 edit`),默认关,且是**隐式 mutation**,心智与 git"先显示、你再决定"相反。
- `perforce.cleanRefresh` 名不副实:注释自承 `heavy status/reconcile discovery arrives later`,当前与普通 refresh 等价,`p4 status`/`reconcile` 的发现能力**从未接入**。

### 1.3 根因矩阵

| # | 现象 | 根因 | git 为何没此问题 |
|---|---|---|---|
| 1 | 改了文件面板却不显示 | refresh 只查 `opened`/`changes`,未签出改动(外部工具改的只读文件、磁盘新建、外部删除)服务器不知情 | 面板是 `git status`,直接读磁盘 |
| 2 | 无法在面板里签出一个未签出文件 | edit/add/delete 无菜单项 + 未签出文件不在面板 | 未跟踪/已改文件本就在面板,stage 是每行 inline |
| 3 | 编辑器外改动永不反映 | 无 watcher;轮询默认关;失焦回来不刷新 | 有文件监视 + 聚焦刷新 |
| 4 | cleanRefresh 名不副实 | reconcile/status 发现能力未接 | — |
| 5 | 收集靠隐式 mutation | autoEdit 默认关且静默改服务器 | git 从不隐式改状态 |
| 6 | 批量/多选缺位 | revert 仅单行 inline;无"全部收集/还原全部/多选" | 有 stageAll/discardAll/文件夹级 |

核心是 **#1 + #2**:面板 ≠ 磁盘真相,且没有把"磁盘已改但未纳入 p4"的文件收拢进来的入口。

---

## 2. 设计原则

1. **面板向 git 心智靠拢**:磁盘上的改动应"先被看见",再由用户一键收集,而非要求用户先记得签出。
2. **不破坏 p4 领域模型**:changelist 分组、have 基线、submit 直达 depot 等 p4 本质保留,不强行套 git 的两组模型。
3. **安全优先**:发现能力用 dry-run(`-n`),绝不隐式改服务器状态;`autoEdit` 从"唯一收集手段"降级为纯可选加速。
4. **红线不动**:凭据只走 stdin、env 净化、参数数组化、`_mutate` 编排复用 —— 全部照 skill `extend-perforce-plugin` 保持。

---

## 3. 方案(按优先级分阶段)

### 🔴 P0-A —— 新增「待收集的改动」分组(对标 git 的 Changes/Untracked)

**这是补齐 git 差距的关键一招,直接回应"收集修改"。**

**交互设计**
- refresh(至少 `cleanRefresh`,见 §4 取舍)时额外跑 **`p4 reconcile -n -a -e -d`**(dry-run,`-n` 只报告不改服务器,安全):
  - `-e` 磁盘改了但未签出的受控文件 → 推断 `edit`
  - `-a` 磁盘新建、depot 里没有的文件 → 推断 `add`
  - `-d` 磁盘删了但 depot 仍有的文件 → 推断 `delete`
- 结果作为一个**固定分组**「待收集的改动 / Changes to reconcile」,置于默认 changelist **之上**(视觉上"先看到待处理,再看到已签出"),空时隐藏。

**信息呈现**
- 每行复用现有 A/E/D 色标(`p4Decoration.ts` 的 `ACTION_STYLE`),但用一个新的 `contextValue`(建议 `R`,reconcile 待收集)与已签出行区分,便于 `when` 子句挂"收集"动作而非"还原"。
- 单击 = have vs 本地对比(新建文件直接打开),复用 `openChange`。

**操作流程**
- 行 inline **「收集(reconcile)」**:对该文件跑真正的 `p4 reconcile`(去掉 `-n`),它自动变为 opened,跳进默认/编号 changelist,行从"待收集"组消失、出现在下方 changelist 组。
- 组标题 inline **「全部收集」**:一键 reconcile 整组。
- 行 inline 亦可提供"忽略此次"(纯视觉,不落盘)——可选,P2 再定。

**收益**:用户流程从"必须先想起签出再改"变成 git 式"改完就看到、一键收进来"。autoEdit 从此退居纯可选。

> ⚠️ 解析红线:`reconcile -n` 属"报表型"命令。按 skill,先在真服务器验证 `p4 -Mj reconcile -n ...` 是否吐结构化字段;不稳则用 `-ztag`(`execTagged`)。解析写进新纯函数模块 `reconcileParser.ts` + fixture 单测,`client.ts` 只做编排。
> ⚠️ 性能:`reconcile -n //...` 在大 workspace 可能慢。取舍见 §4——默认只在 `cleanRefresh` / 聚焦刷新跑,普通 `_mutate` 后的轻量 refresh 不跑,避免每次操作都全盘扫。

---

### 🔴 P0-B —— 补齐签出/新增/删除的入口(解开"点不到签出"死结)

**交互设计**(纯 `package.json` `menus`,命令已存在)
- `scm/resourceState/context`:对"待收集"组的行(`scmResourceState == R`),按推断动作提供 inline 的**单一**收集动作(见 P0-A);同时在 `1_open` 子组提供 edit/add/delete 显式项(应对推断不准时手动指定)。
- **Explorer 右键**:`scmProvider` 在 explorer 用不了(skill 明载的坑),改用 `resourceScheme == file` 门控,加 "Perforce: 签出 / 新增 / 删除 / 打开改动"。这是 git 用户最自然的入口——在文件树里对一个文件直接签出。
- **editor/title**:对齐 git 的 `git.openChange`,给活动编辑器加"打开改动"按钮;可复用 git 的 `shift+alt+y` 键位习惯(p4 用同一命令语义)。

**收益**:即使不做 P0-A,用户也能在 explorer / editor 里把任意文件签出;做了 P0-A 则形成"看到待收集 → 一键收集"闭环。改动面最小(几乎纯 manifest)。

---

### 🟡 P1-A —— 让面板跟随磁盘变化刷新(无 watcher 的最优替代)

**交互设计**(不加轮询压力)
- **窗口聚焦刷新**:监听窗口 focus,切回编辑器时刷一次(可 debounce),捕捉"在别的工具改了文件"这一最常见场景。需确认宿主是否暴露 focus 事件;若无,作为宿主小改列入依赖。
- **保存后轻量校验**:复用 `workspace.onDidChangeTextDocument`(已被 autoEdit 使用)防抖,对该**单文件**跑 `p4 fstat` / `reconcile -n <file>`,把它挪进/挪出"待收集"组——单文件成本低,不全盘扫。
- 保留 `refreshInterval` 作兜底,文档改为把"聚焦刷新"作默认推荐,轮询留给 CI/共享盘等特殊场景。

---

### 🟡 P1-B —— 批量与组级操作对齐 git

- **多选**:revert / openChange / reopen / 收集 接受多行选中(host 传路径数组),对齐 git 多选 stage/discard。`client.ts` 各方法已接受 `readonly string[]`,主要是命令层与 manifest。
- **组级**:默认组标题 inline 补「全部收集」(P0-A 内);编号组补「还原整组」(带确认)。
- **`revertUnchanged` 提升可见性**:从藏在 `acceptInputActions` 提到组标题常驻,文案改「清理未改动的签出」。

---

### 🟢 P2 —— 信息呈现与文案打磨

- **default 输入框引导**:无 opened 文件时给一句"改动会先出现在『待收集』,收集后可在此填描述并提交"的空态提示。
- **编号 changelist 描述**:组标题常驻「编辑描述」inline(命令已存在,补 inline 即可)。
- **submit 不可逆预期**:submit 确认框明确"提交后不可撤销"(git 有 amend/undo,p4 没有,防习惯误操作)。
- **状态栏**:连接态之外增显"默认组 opened 数 / 待收集数",给"还有多少没处理"的全局感知,对标 git 的 ahead/behind。
- **cleanRefresh 正名**:明确其为"含 reconcile 发现的全量刷新",与普通 refresh 区分,文档说明何时用。

---

## 4. 关键取舍

**Q:reconcile 在哪跑?每次 refresh 都跑吗?**
不。`reconcile -n //...` 在大 workspace 可能秒级。取舍:
- **普通 `_mutate` 后的 refresh**:只跑 `opened`+`changes`(现状),快。
- **`cleanRefresh` / 窗口聚焦 / 手动"扫描待收集"**:跑 reconcile 发现,填充"待收集"组。
- 单文件保存后:只对该文件跑 `reconcile -n <file>`,增量更新。
- 可加配置 `perforce.autoReconcile`(默认 false):开启后普通 refresh 也带 reconcile,交给愿意付性能代价的用户。

**Q:为什么不直接默认开 autoEdit?**
autoEdit 是隐式 mutation(改文件即改服务器状态),与"先看见再决定"的 git 心智相反,且 add/delete 它覆盖不到。"待收集"分组是显式、可预览、覆盖 add/edit/delete 三态的更完整方案;autoEdit 保留为可选加速。

---

## 5. 落地映射(改动面预估,供后续编码)

| 方案 | package.json | client.ts | 新解析模块 | 宿主/contribution | 用户文档 |
|---|---|---|---|---|---|
| P0-A 待收集分组 | reconcile 命令 + inline 菜单 + nls | `getReconcilePreview()` + 固定组对账 | `reconcileParser.ts` + 单测 | — | daily-workflow 新增"收集/协调" |
| P0-B 菜单入口 | edit/add/delete 加 resourceState + explorer + editor/title(+ 键位) | — | — | — | daily-workflow / overview |
| P1-A 聚焦刷新 | — | 订阅 focus / save 增量 | — | 可能需宿主暴露 focus 事件 | resolve-and-advanced 刷新章节 |
| P1-B 批量/组级 | 组标题 inline + 多选 | 命令接受多路径 | — | host 多选传参 | daily-workflow |
| P2 呈现 | 文案/nls | 小改 + 状态栏 | — | p4StatusBar | 全文案校对 |

**验证**(每阶段完成后):
- `pnpm --filter @universe-editor/perforce test`(纯解析单测先行,尤其 reconcileParser)
- `pnpm check`(lint+typecheck+全测+docs:check,仅看错误)
- 交互流程改动 → `pnpm e2e`(本地 Windows 有 launch flake,交 CI)
- 用户可见改动 → 同步 `docs/user/zh-CN/perforce/`,内部链接勿留死链

**红线复核**(照 skill `extend-perforce-plugin`):
- reconcile/status 均 dry-run 发现,收集才真跑;破坏性确认留在命令层不进 client 方法。
- 所有新 spawn 走 `P4Service`(env 净化 + 数组参数);报表命令先验 `-Mj` 再决定 `-ztag`。
- 路径比较走 `pathUtil.ts` `norm()`,不手写大小写折叠(ESLint 护栏)。

---

## 6. 建议推进顺序

1. **P0-B**(菜单入口)——改动面最小、立即解开"点不到签出",可先行合入。
2. **P0-A**(待收集分组)——核心体验补齐,追平 git untracked/modified。
3. **P1-A**(聚焦刷新)——让面板"活"起来,减少手动刷新。
4. **P1-B / P2** —— 批量与打磨,逐步收敛。

完成 P0-A + P0-B 后,p4 的"收集修改"体验即基本追平 git。

---

## 7. 实施状态(2026-07-11)

全部阶段已落地,`pnpm check` 全绿、perforce 113 单测通过、docs:check 无死链。

| 阶段 | 状态 | 交付 |
|---|---|---|
| P0-A 待收集分组 | ✅ 完成 | `reconcileParser.ts`(+8 单测)、置顶固定组、`reconcile`/`reconcileAll`、`reconcile -n` dry-run 发现 + 过滤已签出 |
| P0-B 菜单入口 | ✅ 完成 | 待收集行/组 inline、explorer 右键(edit/add/delete/openChange/reconcile)、editor 标题栏 openChange、`resolveTargetPath` 修 `UriComponents` |
| P1-A 文件监视自动刷新 | ✅ 完成 | `workspaceWatcher.ts` 用 node `fs.watch(root,{recursive})` 监视工作区(对齐 git),防抖后触发 `refresh({reconcile:true})`;编辑器保存与外部改动均覆盖;`perforce.autoRefresh`(默认开) |
| P1-B 组级还原 | ✅ 完成 | `revertChangelist`(默认/编号组标题,带确认) + `revertUnchanged` 并存区分 |
| P1-B 多选 | ⏸ 暂缓 | **宿主受限**:SCM 行命令只传单 `resource`,真多选需改宿主选择模型 + 命令传参协议,留作后续独立项 |
| P2 呈现打磨 | ✅ 完成 | 状态栏 opened/待收集计数 + tooltip;submit 确认框注明不可撤销;输入框空态引导文案;cleanRefresh 正名 |

**新增配置**:`perforce.autoReconcile`(默认关)、`perforce.autoRefresh`(默认开,文件监视触发带 reconcile 发现的自动刷新)。

**唯一遗留**:P1-B 多选(宿主能力所限)。其余计划项全部完成。
