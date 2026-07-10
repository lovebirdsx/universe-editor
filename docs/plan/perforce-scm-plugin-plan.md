# Perforce (p4) SCM 外部插件设计方案

> 目标:为 universe-editor 增加一个与内置 Git 扩展对等的 **Perforce 外部插件**(`extensions/perforce`),通过既有的 extension-host 进程 + 类 VSCode SCM API 接入编辑器。本方案**只做设计,不涉及编码**。
>
> 范围裁定(已与用户确认):
> - **功能深度 = 核心 + 进阶**:连接/登录、changelist 分组视图、edit/add/delete/revert、submit、与 depot(have 版本)diff、手动+操作后刷新;并含 **numbered changelist 管理(创建 / `reopen` 搬文件)、shelve/unshelve、resolve 冲突解决、保存时自动 checkout**。接近社区事实标准 `mjcrouch.vscode-perforce` 的完整能力。
> - **宿主策略 = 彻底通用化**:把 renderer 侧 SCM 视图里残留的 Git 专属硬编码,全部抽象成「由 provider 通过 SCM API 上报的能力」,使宿主对任何 SCM 零专属知识。p4 与 git 因此共用同一套无偏见宿主。

---

## 1. 背景与既有资产

### 1.1 插件系统与 SCM 管线现状

编辑器已有一套完整的 VSCode 式外部插件系统(详见 memory `extension-system-progress`、skill `create-extension`):

- **三进程模型**:`main`(只搬 stdio 字节)↔ `extension-host`(独立 Node 进程,跑扩展 `activate`)↔ `renderer`(命令注册表 / SCM 视图 / UI 宿主)。RPC 复用 platform 的 `ChannelServer/Client + ProxyChannel`,stdio 换行分帧。
- **双 host 信任级隔离**:内置扩展跑 trusted host(可用 `node:child_process`/`fs`/`ai` 等 raw 能力);用户装的扩展跑 restricted host。**p4 是内置(first-party)扩展,进 trusted host**,可直接 spawn `p4` CLI —— 与 git 扩展 spawn `git` 同构。
- **加载即发现**:放进 `extensions/perforce/` 即被扫描器自动激活,`runtime:stage` 把 `extensions/*` 打进发布产物,**无需在主程序手动注册**。
- **SCM API 面**(`packages/extension-api/src/scm.ts`):`scm.createSourceControl(id,label,rootUri)` → `SourceControl{ inputBox, count, commitTemplate, acceptInputCommand, createResourceGroup }`;`SourceControlResourceGroup{ id,label,hideWhenEmpty,resourceStates }`;`SourceControlResourceState{ resourceUri,command,decorations,contextValue }`。
- **SCM 视图是单一共享宿主**:容器 `workbench.view.scm`(`BuiltInViewContainersContribution`)+ 视图 `workbench.view.scm.main`(`ScmView`)。多个 provider 通过顶栏下拉切换(`ScmViewToolbar` 的 repo selector);activity bar badge(`ScmActivityContribution`)对所有 provider 的 `count` 求和。**p4 provider 注册后自动出现在同一「源代码管理」面板的下拉里** —— 这正是 VSCode 的行为。

### 1.2 Git 扩展作为直接模板

`extensions/git/` 是「全贡献点样板」,p4 几乎逐目录对位:

| Git 扩展文件 | 职责 | p4 对位 |
|---|---|---|
| `gitService.ts`(`gitExec` = spawn argv + env denylist) | CLI 封装 | `p4Service.ts`(`p4Exec`,加 `-ztag`/`-Mj` 解析) |
| `statusParser.ts`(解析 `status --porcelain=v2 -z`) | 状态解析 | `openedParser.ts` / `fstatParser.ts`(解析 `-ztag`) |
| `repository.ts`(SourceControl + 两固定组 + watcher) | 单仓聚合 | `client.ts`(SourceControl + **动态 changelist 组**) |
| `repositoryManager.ts`(多 repo 按 rootUri 路由) | 多仓路由 | `clientManager.ts`(多 client 按 rootUri 路由) |
| `gitStatusBar.ts` | 状态栏 | `p4StatusBar.ts`(client/stream/连接态) |
| `repoDiscovery.ts`(扫 submodule) | 发现 | `clientDiscovery.ts`(P4CONFIG / `p4 info`) |
| `extension.ts`(命令接线) | 入口 | `extension.ts`(命令接线) |
| `gitError.ts` / `nls.ts` / `package.nls*.json` | 错误/本地化 | 同构复用套路 |

**但 p4 不是「git 换命令」** —— 模型差异见 §2,直接照搬 git 的心智会错。

---

## 2. Perforce 领域模型 → SCM API 映射

这是全方案的核心。Perforce 是**中心化 + 悲观锁 + 服务器端多 changelist** 模型,与 git 的本地化/自由编辑/单一 staging 截然不同。

### 2.1 概念对照

| 维度 | Git | Perforce | 对 SCM API 的影响 |
|---|---|---|---|
| 仓库单位 | 一个 `.git` 目录 | 一个 **client(workspace spec)**:depot↔本地路径映射 + `Root` | `SourceControl.rootUri` = client `Root`;`label` = client 名(可附 stream) |
| 暂存 | 全局唯一 index,可 hunk 级 | **多个 pending changelist 并存**,文件**整体**属于**唯一一个** CL | ResourceGroup **动态多组**,非 git 的固定两组 |
| 提交 | `commit`(本地)+ `push` | `p4 submit`(直达中央 depot,原子) | 无 push/pull;submit = 提交 default 或某 numbered CL |
| 编辑前 | 自由改 | **必须 `p4 edit`(checkout)**,同步下来的文件是只读 | 「保存/改动时自动 checkout」是 p4 独有一等交互 |
| 本地基线 | HEAD/index(本地 blob) | **have revision**(你上次 sync 到的 depot 版本),内容在服务器 | dirty-diff 基线要经 `p4 print` 取服务器内容 |
| 搁置 | `git stash`(本地) | `p4 shelve`(**推服务器**,可协作/review) | shelve/unshelve 是 p4 独有 |
| 冲突 | merge 时本地 resolve | `p4 resolve`(sync/integrate 后) | resolve 是独立一等命令 |
| 刷新 | `.git` watch 即时 | 状态在**服务器**,本地 FS 事件感知不到 | **显式 Refresh + 操作后局部刷新**,不能靠 watcher |

### 2.2 ResourceGroup 划分(主轴:changelist → group)

**放弃 git 的 `Staged / Changes` 二分。** p4 结构:

1. **Default changelist** → 固定 group(`id='default'`,label「Default Changelist」),始终存在。
2. **每个 numbered pending changelist** → 一个动态 group(`id='cl:<n>'`,label=`#<n>: <描述首行>`)。
3. **Shelved files** → v1 作为对应 CL 的**独立子 group**(`id='shelved:<n>'`),或该 CL 内的一段。

`count`(activity badge)= 所有 pending group(default + numbered)里 opened 文件总数,**不含 shelved**,给用户「手上开着多少文件」的直觉。

> 「把文件从 A 组移到 B 组」= `p4 reopen -c <B>`(不是 git 的 stage/unstage)。这是 p4 版的「重新组织改动」。

### 2.3 ResourceState 构造(action 比 git 丰富)

每个 opened 文件一个 state:
- `resourceUri` = 本地路径(点击打开、Explorer 装饰关联)。
- `command` = 点击默认打开 **本地 vs have 版本的 diff**(add 文件则直接打开)。
- `contextValue` = p4 action 类型(供菜单 `when` 精确控制行内按钮),取值:`edit / add / delete / move-add / move-delete / branch / integrate`,冲突时追加 `unresolved`。
- `decorations` = 按 action 给 badge 字母 / 颜色 / tooltip(delete 用删除线)。

> p4 独有的 `branch / integrate / move-add / move-delete / unresolved` 状态,git 没有。`move` 在 UI 上是**一对** resource(源 move-delete + 目标 move-add),可折叠显示。

### 2.4 InputBox —— 关键反直觉结论:**基本弃用**

git 用 InputBox 作全局 commit message + `acceptInputCommand`。但 **p4 的提交描述属于「某个具体 changelist」**,不是全局单一 message。社区标准 mjcrouch **没有 `scm/inputBox` 贡献**,提交描述走独立的 changelist spec 编辑流程。

**本方案决策**:
- 默认**不把 InputBox 当全局 commit message**。submit 时:
  - default CL → 弹输入框/描述编辑器收集描述,再 `p4 submit`。
  - numbered CL → 描述已在服务器,直接 submit;改描述走 `p4 change` 表单(`perforce.editChangelist`)。
- InputBox 可选作 default changelist 的描述草稿(纯便利,不是主路径)。

### 2.5 连接 / 配置 / client 发现

- **配置优先级**:环境变量/`p4 set`(`P4PORT`/`P4USER`/`P4CLIENT`)> `P4CONFIG` 文件(各 client root,支持一窗口多 client)> 编辑器 settings 兜底(`perforce.port/user/client`)。
- **密钥红线**:密码/ticket **绝不进明文 settings/aiSettings/线协议**,走 `ISecretStorageService`(对齐仓库套路 I)。ticket 由 p4 自身写 `P4TICKETS`,插件不自管。
- **发现**:`p4 -ztag info` → `clientName`/`clientRoot`/`serverAddress`,据此建 SourceControl(`rootUri=clientRoot`)。文件是否受控:`p4 -ztag fstat <file>` 有 `depotFile` 即在 depot 下。
- **激活时机**:建议**打开一个受控文件才建 provider**(避免非 p4 项目空转),不像 git 用 `onStartupFinished` 常驻。见 §5 activationEvents。
- **一窗口多 client**:P4CONFIG 扫描出多个 client → 多个 SourceControl,天然复用共享宿主的下拉切换。

---

## 3. 宿主彻底通用化改造(renderer 侧)

一手调研结论:**SCM 宿主内核已基本通用**(ScmService 全通用、ScmView 骨架/Toolbar/菜单映射/装饰派生/activity badge 全通用)。Git 专属硬编码集中在少数几处。按用户「彻底通用化」的选择,逐一抽象成 provider 能力,使宿主对 SCM 零偏见。

### 3.1 必改项(3 处 Git 硬编码 → provider 能力)

#### G1. Folder 行内联动作写死 git — `ScmView.tsx:499-529`
现状:tree 视图里文件夹行按 `node.groupId === 'index'` 决定显示 `git.unstage` 还是 `git.stage`+`git.discard`,命令/图标/概念全 git。对 p4 会显示**错误按钮**(p4 无 stage/index)。

**改造**:新增菜单位 **`scm/resourceFolder/context`**,folder 行像 file 行一样走 `menuActions(MenuId.ScmResourceFolder, scope, 'inline')`,scope 带 `scmProvider + scmResourceGroup`。宿主不再硬编码任何命令。
- git 扩展迁移:把现有 folder 动作改为在 manifest 贡献 `scm/resourceFolder/context`(`when: scmResourceGroup==index` → unstage;`when: scmResourceGroup==workingTree` → stage+discard)。
- p4 贡献:folder 级 `revert`/`reopen`(可选;p4 folder 操作弱,也可不贡献 → 无按钮)。

#### G2. Commit 按钮 `isGitProvider` 分叉 — `ScmView.tsx:94-119, 791-817`
现状:`COMMIT_ACTIONS` 常量写死 4 个 git 命令;`model.id==='git'` 才显示带下拉的多提交动作,否则走单一 `acceptCommand`。

**改造**:把「提交动作组」提升为 **provider 通过 SCM API 上报的能力**(对标 VSCode 的 `SourceControl.actionButton` + secondary actions):
- SCM API `SourceControl` 增 `acceptInputActions?: Command[]`(主 + 次动作列表)与已有 `acceptInputCommand`(主)。
- 宿主 commit 栏:有多动作 → 渲染主按钮 + 下拉(sticky 记忆最后选择,现有逻辑保留但数据来自 provider);只有单 `acceptCommand` → 单按钮;都没有 → 隐藏。
- 删除 `isGitProvider` / `COMMIT_ACTIONS` / `showCommitMenuButton`。
- git 迁移:activate 时上报 `[commit, commitAmend, commitAndPush, commitAndSync]`。
- p4:上报 `[submitDefault]`(default 组)或按选中组上报 submit;无多动作即单按钮。

#### G3. Active-repo 同步命令写死 git — `ActiveRepoSyncContribution.ts:46`
现状:SCM 视图选中 repo 时 `executeCommand('git.setActiveRepo', rootUri)` 把选择推给 git host,让无参命令作用于选中 repo。命令 id 写死 git。

**改造**:把「活动 source control」提升为**宿主级通用概念**。方案二选一(推荐 A):
- **A(推荐)**:SCM API `SourceControl` 增 `onDidSelect?: Event`(或宿主在选中变化时对**当前选中的 provider** 发一个约定命令 `<providerId>.setActiveRepo`,由各扩展可选实现)。宿主不再硬编码 `git.`。
- **B**:`ExtHostScm` 加 `$onDidChangeSelectedSourceControl(handle)` 反向通道,host 侧 ExtensionService 路由到对应扩展的回调。更干净但改动线协议。

`ActiveRepoSyncContribution` 改为遍历/按选中 provider 发通用信号;git 与 p4 各自实现自己的 `setActiveRepo`。

### 3.2 装饰权重通用化 — `ScmDecorationsService.ts:58-71`
现状:`LETTER_WEIGHT` 用 git 状态字母(U/D/M/R/C/A/?),`?`→`U` 映射是 git 假设。字母本身来自 provider 的 `contextValue`(通用),但权重排序是 git 味。

**改造**:权重表设**可回退默认**(未知字母给中间权重),不写死 git 专属映射;或允许 provider 在 decoration 里带排序提示。p4 的 action 字母(E/A/D/B/I/M)因此能正确排序。改动小,非阻塞。

### 3.3 dirty-diff / blame / merge-conflict — 底层通用,数据源需 p4 版

这三者的**底层组件全通用**(diff 计算、gutter/peek/导航、冲突标记扫描、blame 渲染骨架),差异只在「数据从哪来」:

- **dirty-diff**(`extensions-common/dirtyDiff.ts` + `DirtyDiffContribution.ts`):baseline 取 `git.getHeadContent`,Stage Change 发 `git.stageChange`,Open Changes 发 `git.openChange`。
  - **通用化**:baseline 改为「向当前活动 provider 要基线内容」的通用命令(如约定 `<providerId>.getBaselineContent(path)`)。p4 对等实现 = `p4 print -q <file>#have`(**比较 have 版本,非 latest**,且带缓存)。
  - **Stage 概念 p4 没有**:dirty-diff peek 里的「Stage Hunk」动作应**按 provider 能力可隐藏**(p4 无 hunk 级暂存)。
  - 决策:p4 v1 **可先不接 gutter dirty-diff**(仅对已 checkout 文件有意义 + 每次取 have 走网络),留作 v2;或接只读版(只显示改动条,不含 Stage)。
- **blame**(`GitBlameContribution` + `git.getBlame`):p4 有 `p4 annotate` 对等,但**优先级低**,非 SCM 视图核心。渲染骨架可复用,数据/配置/跳转需 p4 版。v2 再做。
- **merge-conflict**(`mergeConflict/conflictParser.ts`):纯文本扫描 `<<<<<<< ======= >>>>>>>`,**完全不调 git**。p4 resolve 若产出标准冲突标记即**直接复用**;p4 默认标记不同,需要么配置 p4 用标准标记,要么扩 parser 支持 p4 标记。p4 的结构化 resolve(`p4 resolve`)是另一条路,v1 走命令行交互 + 手动。

### 3.4 明确不移植:Git Graph
`workbench/gitGraph/*` 全套(commit DAG、分支、cherrypick/rebase/tag/stash)命令全 `git-graph.` 前缀。**p4 无 commit DAG 概念**(changelist 线性),**不移植**。其「内置 editor 托管机制」(`GitGraphEditorInput` + `BuiltInEditorProvidersContribution`)可作为 p4 若要做「changelist/submitted history 主区视图」的**参考模板**(v2 可选)。

### 3.5 通用化改造清单汇总

| 项 | 文件 | 改造 | 优先级 |
|---|---|---|---|
| G1 folder 行动作 | `ScmView.tsx:499-529` | 新增 `scm/resourceFolder/context` 菜单位,走 menuActions | **P0**(否则 p4 显示错误按钮) |
| G2 commit 动作组 | `ScmView.tsx:94-119,791-817` | SCM API 增 `acceptInputActions`,删 isGitProvider | **P0** |
| G3 active-repo 同步 | `ActiveRepoSyncContribution.ts:46` | 通用「活动 provider」信号 | **P0** |
| 装饰权重 | `ScmDecorationsService.ts:58-71` | 权重可回退默认 | P1 |
| 菜单 id 映射加 folder 位 | `ExtensionPointTranslator.ts:47-57` | `MENU_ID_BY_KEY` 加 `scm/resourceFolder/context` | P0(随 G1) |
| SCM API/wire 扩展 | `extension-api/scm.ts`、`extensions-common/scmWire.ts` | 见 §4 | P0 |
| dirty-diff 基线通用化 | `extensions-common/dirtyDiff.ts`、`DirtyDiffContribution.ts` | 通用基线命令 + Stage 可隐藏 | P1(p4 gutter 属 v2) |

---

## 4. SCM API / wire 契约扩展

为支撑 §2/§3,`packages/extension-api/src/scm.ts` + `packages/extensions-common/src/scmWire.ts` + host `hostScm.ts` + renderer `ScmService.ts` 需要几处扩展(全部前向兼容,git 也受益):

1. **提交动作组**(支撑 G2):`SourceControl.acceptInputActions?: Command[]`。wire 加 `ISourceControlFeaturesDto.acceptInputActions?: ICommandDto[]`;ScmService model 加 observable;ScmView 消费。
2. **活动 provider 选择反馈**(支撑 G3,若选方案 B):`IExtHostScm.$onDidChangeSelectedSourceControl(handle)`;host 路由到扩展 `SourceControl.onDidSelect`。
3. **通用基线内容**(支撑 dirty-diff 通用化,P1):约定命令而非 API 面 —— 活动 provider 注册 `<id>.getBaselineContent`。宿主 DirtyDiff 改调「当前 provider 的基线命令」。无需改线协议。
4. **folder 菜单位**(支撑 G1):platform `MenuId.ScmResourceFolder` + `ExtensionPointTranslator.MENU_ID_BY_KEY` 加 `'scm/resourceFolder/context'`。纯 renderer + platform,不涉线协议。

> 这些扩展**不 bump** `extension-api` 的破坏性版本(纯新增可选字段);但若走方案 B 改 wire,需同步 host+renderer 两端。所有内置插件 `engines.universe` 维持 `">=0.1.0 <1.0.0"`。

---

## 5. 插件内部架构(`extensions/perforce/`)

### 5.1 目录结构(对位 git 扩展)

```
extensions/perforce/
  package.json            manifest:commands/submenus/menus/keybindings/configuration + engines + activationEvents + files + NLS
  package.nls.json        英文默认文案
  package.nls.zh-cn.json  中文文案
  icon.svg
  esbuild.config.mjs      逐字复制 git 的,改 label
  tsconfig.json / vitest.config.ts
  src/
    extension.ts          activate:发现 client → 建 manager → 接线命令;deactivate
    p4Service.ts          p4Exec(args,cwd,{input?}) = spawn('p4', argv) + env denylist + -Mj/-ztag 解析;connect/login 探测
    p4Output.ts           tagged/-Mj 输出解析(平行编号 key → 数组;JSON 行)
    clientDiscovery.ts    P4CONFIG 扫描 + `p4 info` → client 列表 + root
    clientManager.ts      多 client 按 rootUri 路由(对位 repositoryManager)
    client.ts             一个 client 的 SourceControl + 动态 changelist 组 + 刷新编排(对位 repository)
    changelist.ts         changelist 模型 + 分组构建(default/numbered/shelved)
    openedParser.ts       解析 `p4 -ztag opened`(文件→action→CL)
    fstatParser.ts        解析 `p4 -ztag fstat`(受控性/haveRev/headRev)
    p4StatusBar.ts        连接态/client/stream 状态栏(对位 gitStatusBar)
    p4Error.ts            失败通知 + session-expired 拦截 → 触发 login → 重试(对位 gitError)
    autoEdit.ts           保存/改动时自动 checkout(悲观锁,见 §5.4)
    baselineProvider.ts   have 版本内容 provider(p4 print,按 depotPath#rev 缓存)供 diff/dirty-diff
    concurrency.ts        p4 进程并发闸(限 maxConcurrent)
    nls.ts                运行时 localize(内嵌 locale 表,对位 git/nls.ts)
    __tests__/            openedParser / fstatParser / changelist 分组 / p4Output / autoEdit 纯逻辑单测
```

### 5.2 CLI 接口层(`p4Service.ts` + `p4Output.ts`)

- **spawn 模式**:`spawn('p4', [...globalOpts, ...args])`,argv 数组(不拼 shell,防注入),env denylist 剥离(同 gitExec 的 ELECTRON_*/NODE_OPTIONS),`shell:false`。全局选项前置:`-c <client> -u <user> -p <port>`。
- **结构化输出**:优先 **`-Mj`**(JSON 行,`JSON.parse` 最省);探测服务器不支持则回退 **`-ztag`**(tagged 文本,解析器把 `depotFile0/depotFile1...` 平行编号 key 收敛成数组)。**不用 `-G`**(Python marshal,Node 不友好)。
- **stdin**:login 收密码、change spec 表单经 stdin 喂入(复用 gitExec 的 `input` 机制)。
- **并发闸**(`concurrency.ts`):每个 p4 命令 = 进程 spawn + 网络往返,并发过高拖垮服务器/本机。限 `maxConcurrent`(可配置,默认如 4)。**git 无此需求**(本地操作廉价)。

### 5.3 状态查询与刷新策略(p4 性能红线)

| 目的 | 命令 | 用途 |
|---|---|---|
| opened 文件 + 所在 CL | `p4 -ztag opened` | **主力刷新源**,构建 group |
| pending CL 列表+描述 | `p4 -ztag changes -s pending -c <client>` | numbered group |
| 单文件详情/have 版本 | `p4 -ztag fstat <file>` | 受控性、diff 基线 |
| shelved 内容 | `p4 -ztag describe -S <CL#>` | shelved group |
| **发现未受控改动** | `p4 status` / `p4 reconcile -n` | **重操作,仅手动触发** |
| have 版本内容 | `p4 print -q <file>#have` | diff 左侧,带缓存 |

**刷新模型(与 git 根本不同)**:
- **不依赖文件系统 watcher** 做实时状态(状态在服务器,FS 事件感知不到别人 submit / ticket 过期)。
- **常规刷新 = 轻量**:`opened` + `changes -s pending`(服务器元数据查询,规模无关)。
- **`status`/`reconcile` 是重操作**:做成显式「查找未受控改动 / Reconcile」命令,可限范围,**绝不进自动刷新循环**(大 depot 会几十秒)。
- **触发点**:① `scm/title` 常驻 `Refresh`/`Clean Refresh`;② **每个 mutating 命令完成后局部刷新**(只刷受影响的 CL 组,减闪烁+减负载);③ 可选低频轮询(默认保守/可关,尊重并发闸)。

### 5.4 悲观锁:保存/改动时自动 checkout(`autoEdit.ts`)

p4 最重要也最易踩坑的交互。同步下来的文件磁盘上**只读**,编辑前需 `p4 edit`。三个开关(对位 mjcrouch,**默认关**):`editOnFileSave` / `editOnFileModified` / `addOnFileCreate`+`deleteOnFileDelete`。

**实现路径(受限于当前 extension-api 无「保存前」事件)**:
- 一手核实:extension-api 目前**有** `workspace.onDidChangeTextDocument`,**无** `onWillSaveTextDocument`/`onDidSaveTextDocument`/`createFileSystemWatcher`。
- **推荐替代 = dirty 触发(`editOnFileModified` 路子)**:监听 `onDidChangeTextDocument`,文件**首次变脏**时后台 `p4 edit`(去只读位),等真正保存时文件已可写。这是无 will-save 事件时的最佳替代。
- **兜底**:作为 trusted 扩展可直接用 `node:fs` 监听 + 捕获保存写入失败(EACCES/只读)→ `p4 edit` → 重试(需要与编辑器保存链路协作;v1 可先只做 dirty 触发)。
- **API 缺口(可选补强)**:若要做干净的「保存前 checkout」,需给 extension-api 增 `workspace.onWillSaveTextDocument` + `waitUntil(Thenable)`(host+renderer 两端接线)。列为**可选后续**,v1 用 dirty 触发绕过。

### 5.5 连接 / 登录 / 离线降级(`p4Error.ts`)

- 启动探测:`p4 info` + `p4 login -s`。失败**不刷屏**,把 SourceControl 置「离线」态(count 清、组置灰、原因进输出面板)。
- 未登录:`scm/title` 高亮 `login`;任意命令遇 `session expired` → 统一拦截 → 提示/收密码登录 → 成功后重试原命令。
- 每个 p4 spawn 都可能因网络/权限失败 → 统一 error → 输出面板 + 非阻塞通知,单命令失败不卡死刷新。
- 文案让用户理解「这些操作需要服务器」(不像 git 离线可用)。

### 5.6 diff 与 baseline(`baselineProvider.ts`)

- 点击 resource / `openChange` → 打开 **本地 vs have 版本** 的 diff:左侧 = `p4 print -q <file>#have`,右侧 = 本地文件。复用宿主内置 `_workbench.openDiff`(git 扩展同款)。
- have 内容按 `depotPath#rev` **缓存**(revision 不变不重取,省网络)。
- move/shelved 等特殊 resource 用「depot 身份 vs 本地身份」分离的多 URI(参考 mjcrouch 的 Resource 多 URI 设计),避免打开错目标。

---

## 6. 命令与菜单贡献(manifest)

命令 id 前缀统一 `perforce.`,category `Perforce`。菜单位对齐 §3 通用化后的位置。

### 6.1 `scm/title`(provider 级,`when: scmProvider == perforce`)
`sync` / `refresh` / `cleanRefresh` / `login` / `logout` / `info(showOutput)` / `newChangelist` / `goToChangelist`。用 submenu 收纳(对位 git 的 commit/changes/... 子菜单)。

### 6.2 `scm/resourceGroup/context` + `scm/resourceFolder/context`(changelist 组级)
`submit`(default/numbered)/ `revert` / `revertUnchanged` / `editChangelist`(改描述)/ `resolveChangelist` / `shelve` / `unshelve` / `deleteShelved` / `describe` / `copyChangelistId`。

### 6.3 `scm/resourceState/context`(文件行级)
`openChange`(diff)/ `revert` / `revertUnchanged` / **`reopen`(移到其他 changelist = p4 版「stage 到别处」)** / `shelve` / `unshelve` / `resolve` / `submitSelected`。行内(`group: inline`)优先放 `openChange` + `revert`。`when` 用 `scmResourceState`(action 类型)细化(如 `unresolved` 才显示 resolve)。

### 6.4 配置(`configuration`)
`perforce.enabled` / `perforce.port|user|client`(兜底)/ `perforce.editOnFileSave|editOnFileModified|addOnFileCreate|deleteOnFileDelete`(默认 false)/ `perforce.maxConcurrent` / `perforce.enableP4ConfigScanOnStartup` / `perforce.refreshInterval`(0=关轮询)。密钥不进配置。

### 6.5 activationEvents
- 推荐 `onView:workbench.view.scm` + 打开受控文件触发(避免非 p4 项目空转)。
- 或保守用 `onStartupFinished`(对位 git),但 activate 内先廉价探测 `p4 info`,非 p4 环境立即 return。

### 6.6 速查:git 有的**别抄** / p4 独有**必做**
- **别抄**:staged/unstaged 二分、stage/unstage/discard-hunk、InputBox 当全局 commit message、push/pull/fetch/本地 commit/amend/branch checkout、git stash、全量 status+watcher 实时刷新、离线可用假设。
- **必做**:多 numbered changelist→多组 + `reopen -c` 搬文件、default 组、edit 悲观锁+自动 checkout、sync/shelve/unshelve/resolve/revert-unchanged/describe/login-logout、branch/integrate/move/unresolved 状态、have 版本 diff、显式刷新+操作后刷新+并发闸、一窗口多 client + SecretStorage。

---

## 7. 分阶段路线图

> 每阶段末尾 `pnpm check`(lint+typecheck+test)全绿;涉交互用 `pnpm dev` 手测(本机 e2e 有 Playwright flake,交 CI)。改 platform/extensions-common/extension-host 后先 build 再验 apps。

### Phase 0 — 宿主通用化(renderer,先行解耦)
把 §3 的 P0 改造做掉,**git 扩展同步迁移到新机制并保持行为不变**(回归基线):
- 新增 `MenuId.ScmResourceFolder` + `ExtensionPointTranslator` 映射;ScmView folder 行改走 menuActions(G1)。
- SCM API 加 `acceptInputActions`;ScmView commit 栏改由 provider 上报驱动,删 `isGitProvider`/`COMMIT_ACTIONS`(G2)。
- active-provider 信号通用化(G3)。
- git 扩展 manifest/activate 相应迁移;跑通现有 SCM 单测 + git 手测无回归。
- **交付物**:宿主对 SCM 零专属知识;git 行为不变。这是 p4 能干净接入的前提。

### Phase 1 — p4 脚手架 + 连接 + 只读展示(MVP 骨架)
- 建 `extensions/perforce/`(照 skill `create-extension` + git 模板)。
- `p4Service`/`p4Output`/`clientDiscovery`/`clientManager`/`client`:`p4 info`+`login -s` 探测 → 建 SourceControl(rootUri=clientRoot)。
- `p4 -ztag opened` + `changes -s pending` → 构建 default + numbered changelist 组(只读展示)。
- `p4StatusBar`:client/连接态。`p4Error`:离线降级 + session-expired 拦截。
- 单测:openedParser / p4Output(平行 key)/ changelist 分组。
- **验收**:p4 workspace 打开后,SCM 面板下拉出现 p4 provider,列出 opened 文件按 changelist 分组;git provider 并存不受影响。

### Phase 2 — 核心 mutating 操作
- `edit`(checkout)/ `add` / `delete` / `revert` / `revertUnchanged`。
- `submit`:default → 收描述 → submit;numbered → 直接 submit。
- resource 点击 → 本地 vs have diff(`baselineProvider` + `_workbench.openDiff`)。
- 每个 mutating 命令后**局部刷新** + 并发闸接入。
- **验收**:覆盖日常 80%(checkout→改→submit→diff)。

### Phase 3 — 进阶(用户要求的深度)
- **numbered changelist 管理**:`newChangelist`、`reopen -c`(文件在组间搬)、`editChangelist`(改描述)。
- **shelve/unshelve**:shelved 子 group + 命令。
- **resolve 冲突**:`resolve`/`resolveChangelist`;merge-conflict 视 p4 标记决定复用宿主 parser 还是走命令行交互。
- **保存时自动 checkout**(`autoEdit`,dirty 触发路子,默认关)。
- **验收**:接近 mjcrouch 完整能力。

### Phase 4 — 打磨 + 可选
- dirty-diff gutter(have 基线,只读版,Stage 隐藏)——若接。
- `p4 annotate` blame(可选,复用渲染骨架)。
- 低频轮询刷新(可关)、P4CONFIG 多 client 完善、`onWillSaveTextDocument` API(若要干净的保存前 checkout)。
- 用户文档 `docs/user/` p4 章节;`runtime:stage`/打包核验产物带上 perforce。

---

## 8. 风险与注意

| 风险 | 说明 | 缓解 |
|---|---|---|
| 宿主通用化引入 git 回归 | Phase 0 动 ScmView/SCM API,git 是唯一现存消费者 | git 扩展同步迁移 + 现有 SCM 单测/StrictMode 测试守护 + 手测基线 |
| 无「保存前」事件,自动 checkout 不干净 | 只读位可能致保存失败 | v1 用 dirty 触发(改动即 checkout)绕过;可选补 will-save API |
| 大 depot 性能 | 全量 status/reconcile 拖垮服务器 | 常规刷新只用 opened/changes;status/reconcile 手动限范围;并发闸 |
| 刷新时效 | 别人 submit / ticket 过期本地无感 | 显式 Refresh + 操作后刷新;文案说明「状态在服务器」 |
| 本机无 p4 服务器验证 | 与 git e2e 同样受限(memory 记录本机 e2e flake) | 纯逻辑抽纯函数单测(parser/分组/autoEdit 决策);连接逻辑手测 + CI |
| 密钥泄漏 | 密码/ticket 误入明文 | 硬红线:只走 ISecretStorageService,DTO/settings 无密钥 |
| 无 p4 CLI 环境 | 用户机器没装 `p4` | `p4 info` 探测失败即禁用 provider + 提示,不报错崩溃 |

## 9. 验证策略
- **单测(node)**:`openedParser`/`fstatParser`/`p4Output`(平行编号 key 收敛)/`changelist` 分组/`autoEdit` 决策/`baselineProvider` 缓存键 —— 全抽纯函数。
- **宿主通用化单测**:扩现有 `ScmView`/`ScmService`/`ScmDecorationsService` 测试覆盖 provider 无关路径(folder 菜单、acceptInputActions、装饰权重回退)。
- **手测(`pnpm dev`)**:连真/测试 p4 服务器,验证连接/分组/checkout/submit/diff/刷新/多 client;git provider 并存无回归。
- **`pnpm check`** 每阶段全绿;**`pnpm ext:build`** 核验 perforce bundle 符号齐;打包前 `runtime:stage` 核验产物带 perforce。

---

## 附:关键参考
- 一手代码:`extensions/git/`(模板)、`apps/editor/src/renderer/workbench/scm/`(宿主)、`packages/extension-api/src/scm.ts` + `packages/extensions-common/src/scmWire.ts`(SCM 契约)、`packages/extension-host/src/hostScm.ts`。
- skill:`create-extension`(新建插件套路)、memory `extension-system-progress` / `scm-submodule-multirepo`。
- 社区方案:`mjcrouch/vscode-perforce`(事实标准)、`slevesque/vscode-perforce`(原始)、官方 P4VS(概念)。
- p4 CLI:`p4 opened / fstat / status / reconcile / changes / describe / print / info / login`;全局选项 `-ztag` / `-Mj`;`p4 print #have` 取基线。
