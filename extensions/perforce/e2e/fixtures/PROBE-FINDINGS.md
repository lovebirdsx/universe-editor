# 真服务器输出形态实测（P4D 2024.2 + P4P 2025.2，工作区 X:/p4ws/main）

探测日期 2026-08-30（§1–§9）与 2026-08-31（§10 复核轮，脚本化，见 `extensions/perforce/scripts/probe-real-workspace.mjs`）。**fake-p4 与解析器都以本文为准**——协议形态假对齐 = 真机行为假绿。

## 1. `sync -n`：`-Mj` 必塌陷，只能走 `-ztag`

| 情形     | 输出通道   | exit  | `-Mj` 形态                                                                       |
| -------- | ---------- | ----- | -------------------------------------------------------------------------------- |
| 有更新   | **stdout** | 0     | `{"data":"//depot/...#2 - deleted as X:\\p4ws\\main\\...","level":0}` ← **塌陷** |
| 全部最新 | **stderr** | **0** | `{"data":"... - file(s) up-to-date.\n","generic":17,"severity":2}` ← **塌陷**    |

- `-Mj` 在**两种情形下都塌陷成 `data` blob**，`execRecords` 的 `isCollapsed()` 会自动回退 `-ztag`——链路可用，但**每次都多跑一次 `-Mj`**（纯浪费）。
- `-ztag sync -n` 记录字段：`depotFile` / `clientFile` / `rev` / `action` / `totalFileSize` / `totalFileCount` / `change`。
- **`clientFile` 是本地路径**（`X:\p4ws\main\...`），不是 client 语法 —— 与 `opened`/`reconcile -n` 相反。`clientToLocalPath` 对本地路径原样返回，故无害，但注释里不能写"必须翻译"。
- **up-to-date 的 exit 是 0，不是非零**；文案在 stderr。

## 2. 真 `p4 sync` 的行数形态

`- deleted as <local>` / `- updated as <local>` / `- added as <local>`（`as` 后跟**本地路径**）。
`sync -n` 与真 `sync` 的行格式一致（dry-run 只是不写盘）。

## 3. `fstat`：`haveRev` 可能是字符串 `none`

`opened -a` 的记录里出现 `... haveRev none`（open-for-add 尚无 have 版本）。任何 `Number(haveRev)` 都要先排除 `'none'`。

`fstat` 单文件字段：`depotFile` / `clientFile`（**本地路径**）/ `isMapped`（裸键）/ `headAction` / `headType` / `headTime` / `headRev` / `headChange` / `headModTime` / `pathSource` / `pathType` / `pathPermissions` / `effectiveComponentType` / `haveRev`。

## 4. `opened -a`：`clientFile` 是**别人 client** 的 client 语法

```
... depotFile //depot/branch_x/Source/Client/Build/.../x.compressed
... clientFile //otherclient/Source/Client/Build/.../x.compressed   ← 别人的 client 名
... rev 4
... haveRev none
... action add
... change default
... type binary
... user testuser
... client otherclient
```

- `user` / `client` 字段确认存在（只有 `-a` 带）。
- **绝不能用自己的 clientRoot 翻译别人的 clientFile** —— 那会拼出一个本地不存在的假路径。「他人占用」的本地路径必须**从 depotFile 反查自己的映射**，或直接用 depotFile 做键。
- `change default` 而非数字。

## 5. `clients`：`-Mj` 必塌陷，字段名首字母大写

`-ztag clients` 字段：`client` / `Update` / `Access` / `Owner` / `Options` / `SubmitOptions` / `LineEnd` / `Root` / `Host` / `Stream` / `Type` / `Backup` / `Description`。

**只有 `client` 是小写**，其余首字母大写（与 `fstat` 的全小写驼峰不同）。`-Mj` 塌成
`{"data":"Client testclient 2026/08/11 root X:\\p4ws\\main '...'","level":0}`。

## 6. `resolve -n` 无冲突时

`//depot/... - no file(s) to resolve.` on **stdout**, exit **0**。

## 7. `fstat -Ru` 无 opened 文件时

`//depot/... - file(s) not opened on this client.` exit 0（**不是**空输出）。

## 8. 规模基线

`X:/p4ws/main` 有 45 万+ 文件；`sync -n Source/Config/Client/...` 单目录就报 `totalFileCount 147`。
`opened -a //depot/branch_x/Source/...` 在无 `-m` 时输出规模不可控 —— **必须带 `-m <max>`**。

## 9. 🔴 `-m` 限制**输出条数**，不限制**服务器工作量**（头号性能坑）

实测耗时（同一工作区、同一时段）：

| 命令                        | scope                                                             | 耗时                                                       |
| --------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `sync -n -m 501`            | `Source/Config/...`                                               | **15.5s**                                                  |
| `sync -n -m 501`            | **client 根**（`X:/p4ws/main/...`，即用户打开整个工程的默认情形） | **>120s，stdout 零字节**                                   |
| `sync -n -m 501`            | `//...`                                                           | **>90s，stdout 零字节**                                    |
| `changes -m 1 -s submitted` | client 根                                                         | **130ms**                                                  |
| `changes -m 1 -s submitted` | 两个 filespec                                                     | **125ms**（`-m 1` 是**每 filespec** 各一条，不是全局一条） |
| `changes -m 1 -s submitted` | `<scope>#have`                                                    | **31s**（`#have` 修饰符使其退化，**不可用作热路径**）      |
| `cstat`                     | `Source/Config/...`                                               | 2.1s / 279KB（输出规模随文件数线性增长）                   |

**结论**：`sync -n` 是 O(scope 文件数) 的**服务器端全量比对**，`-m` 只截断回传条数，服务器该走的映射一样走完。
所以「拿 `-m 501` 当上限保护」是错的 —— 在真实游戏工作区的默认作用域下它会占住一个并发槽数分钟，
正是本仓库「共享 FIFO 并发门被灌满 → 交互命令排队几分钟」那个已修根因的复发形态。

**正确做法（两级探针）**：

1. **廉价门**：`changes -m 1 -s submitted <scope>` （~130ms）拿该 scope 最新提交的 CL 号，与上次记下的比。
   没变 → 直接结束，**完全不碰 `sync -n`**。这是稳态下的绝大多数情况。
2. **贵活**：仅当 CL 号变了才跑 `sync -n`，且只在**用户显式要求**或作用域已被聚焦目录收窄时。

**`#have` 不能用**：`changes -m1 <scope>#have` 要 31s（比裸 scope 慢 240 倍），拿它算「我 have 的最高 CL」
不可行。廉价门只能是「服务器侧最新 CL 有没有动」这个单向信号。

## 10. 2026-08-31 复核轮（脚本化复跑，另一直机工作区）

> 复跑脚本：`extensions/perforce/scripts/probe-real-workspace.mjs`（入库，零依赖 Node）。
> 跑法：`node extensions/perforce/scripts/probe-real-workspace.mjs`；`UNIVERSE_P4_PROBE_SKIP_SLOW=1` 跳过两条最慢探测（client 根 `sync -n`、`<scope>#have`）供快速复跑。脚本内置只读白名单断言（sync 必须带 `-n`、login 必须带 `-s`、其余写命令一律拒绝执行）、每条命令计时、tickets/login 输出不落屏。默认工作区是本机真实工作区（`--workspace`/env 可覆盖）。
>
> 本轮环境：同一对服务器版本（P4D 2024.2 + P4P 2025.2），但工作区不同——本轮是 **stream client**（`testclient`，root `X:/p4ws/main`，stream `//depot/branch_x`），§1–§9 轮次是非 stream 工作区。§9 与本节的耗时差异可能部分源于此。所有真实 depot 路径 / client 名 / 用户名已替换为占位值；CL 号保留（marker 移动证据需要精确数字）。

### 10.1 新发现（前轮未记录）：p4 的 P4CONFIG 查找以 `PWD` 环境变量为起点

实测（同一 cwd，只改子进程 env）：

| 子进程 env                               | `p4 info` 解析到的 client               |
| ---------------------------------------- | --------------------------------------- |
| 无 `PWD`                                 | workspace 的 `.p4config` client（正确） |
| `PWD=/tmp`（POSIX 形）                   | registry 默认 client（**错误**）        |
| `PWD=C:/Windows`（Windows 形但指向别处） | registry 默认 client（**错误**）        |

**结论**：p4.exe 在 Windows 上**只要 env 里有 `PWD` 就用它当 `.p4config` 查找起点，无视进程 cwd**；POSIX 形 PWD 解析必然失败。Git Bash 里 `MSYS_NO_PATHCONV=1` 会让子进程拿到未转换的 POSIX 形 `PWD=/e/...`，从而触发此坑——复跑脚本因此 spawn 时显式剥掉 `PWD` 并设 `cwd=workspace`。
**产品侧影响**：`p4Service.ts` 的 `sanitizeEnv` 剥 `ELECTRON_*`/`NODE_OPTIONS` 但**不剥 `PWD`**。从 msys/WSL 等 POSIX shell 启动编辑器时，扩展宿主继承 POSIX 形 `PWD` → `clientDiscovery` 的裸 `p4 info` 会解析到 registry 默认 client（连错工作区），而不是 workspace 的 client。见「产品问题清单」。

### 10.2 两级探针耗时复核（G1）

| 命令                        | scope                       | 本轮实测                                                    | 前轮记录                         |
| --------------------------- | --------------------------- | ----------------------------------------------------------- | -------------------------------- |
| `changes -m 1 -s submitted` | `//...`（产品默认 scope）   | **426–492ms**（3 连跑；某次冷调用 1152ms）                  | —（前轮测的是 client 根，130ms） |
| `changes -m 1 -s submitted` | 窄目录（视图内 ~1000 文件） | **97–108ms**                                                | 125–130ms ✓                      |
| `changes -m 1 -s submitted` | `//...#have`                | **32546ms**                                                 | 31s ✓                            |
| `sync -n -m 501`            | 窄目录，已最新              | **123–128ms，0 记录**，stderr `file(s) up-to-date.`，exit 0 | 15.5s ⚠️ 不复现                  |
| `sync -n -m 501`            | 中 scope（有 2 个更新）     | **127ms**，2 记录，`totalFileCount 2`                       | —                                |
| `sync -n -m 501`            | client 根                   | **>150s 被超时杀死，0 字节**                                | >120s / 0 字节 ✓                 |

- **稳态跳过实证**：窄 scope 3 连跑 marker 恒定（CL 8439533）→ 脚本按产品决策模拟：首查 RUN `sync -n`，其后 3 次全部 SKIP。**marker 未变时 `sync -n` 确实一次都不发**——两级探针的设计价值成立。
- ⚠️ **默认 scope 的限定**：产品默认 `_syncScopes=['//...']` 是全 depot。本轮观测 depot 级 marker 在约 30 分钟窗口内前移 5 次（8607487→8607546，约 6 分钟一次）——这是活跃服务器。即默认配置下 `perforce.syncPreview.intervalSec`（默认 300s）**每次自动检查都会过门**，随后 `sync -n` 在 20s 超时被白付一次槽位（超时后产品保持旧值，行为正确但每次白烧 20s）。聚焦目录（窄 scope）下 marker 数天不动，才是真稳态。
- ⚠️ **两处与前轮不一致**：① §9 的「`sync -n -m 501 Source/Config/...` = 15.5s」本轮未复现——本轮所有窄/中 scope 均 ≤130ms。可能原因：两轮非同一 client view（本轮 stream client），或 15.5s 时该 scope 有大量更新要回传、服务器负载差异。列为未解差异，勿再引用 15.5s 作典型值。② §8 的「`Source/Config/Client/...` totalFileCount 147」与本轮磁盘实测该目录 13.7 万文件严重不符——两轮映射不同，fake 夹具里的 147 不应再当典型规模。

### 10.3 `opened -a` clientFile 陷阱终审（G2）

- `opened -a -m 50 //...` 输出 50 条、全部是他人记录（`user`/`client` 字段齐全），**50/50 的 `clientFile` 都是他人 client 语法**（`//otherclient2/...`、`//otherclient3/...` 等）——§4 确认。耗时 863ms。
- `haveRev none`：50/50（该批恰全是 open-for-add）；`change default`：40/50（另 10 条为编号 CL）——§4 确认。
- **幻影路径实证**：把他人 `clientFile //otherclient2/...` 用自己的 clientRoot 前缀翻译 → 拼出 `X:\p4ws\main\...` 下**不存在的路径**（磁盘查无）。§4 的红线在真机成立。
- **产品路径实证**：`p4 where <depotFile>` 反查（`_whereLocalPaths` 的实现）：
  - 视图内文件 → 返回正确本地路径且**磁盘存在** ✓；
  - 视图外文件 → stdout 打 `file(s) not in client view.`，**exit 0**（混合批次不会拖垮整批）✓。
- 🔴 **默认 scope 的新问题（本轮的意外发现）**：`opened -a -m 50 //...` 的前 50 条**全部来自其他分支**（`//depot/mainline/...`，与当前 stream `//depot/branch_x` 无关）。产品默认 `runOpenedByOthersScan` 跑 `opened -a -m 301 //...`，others 大概率**全是视图外文件** → `_whereLocalPaths` 返回空 map → 代码走「keep the previous result」→ **他人占用计数与灰字在默认 scope 下永远发布不出来**（`_openedByOthersCount` 恒为初值）。分支内 scope（聚焦目录）则正常：40 条 others，`where` 反查磁盘存在 ✓。详见「产品问题清单」。
- `opened -a -m 301` 耗时 845ms——便宜，无需廉价门的设计判断成立。
- **`-Mj opened -a` 塌成 data blob**（`{"data":"//depot/mainline/...#1 - add ...","level":0}`）。CLAUDE.md 里「`fstat`/`opened`/`changes` 的 `-Mj` 正常」的记载在本服务器不成立：**只有 `fstat` 保持结构化**（普通 `opened`、`changes`、`clients`、`where`、`sync -n` 全部塌）。`execRecords` 的 `isCollapsed()` 认 `data` 键 → 回退链路有效，但 `runOpenedByOthersScan` 每次扫描多付一次注定浪费的 `-Mj` spawn（~800ms ×2）。

### 10.4 fstat 字段形态（G3）

- 本地文件 fstat：`clientFile` = **本地路径**（反斜杠形态 `X:\p4ws\main\...`）✓ §3 确认；`haveRev`/`headRev`/`headAction` 等齐全；未签出时无 `action` 键。
- **open-for-add 的 fstat 到底报什么（本轮新增，§3 未记录）**：用只读 `p4 -ztag -c <他人client> fstat <其 add 的 depotFile>` 以开文件方视角探测：
  - **`haveRev` 键整个缺席**（不是字符串 `'none'`），`action=add`、`change=default`；
  - 全新文件（depot 无历史）：`headRev` 也缺席；re-add（曾删的文件）：有 `headRev`（如 4）且 `headAction=delete`。
  - `'none'` 字符串只出现在 `opened`/`opened -a` 记录里，**fstat 从不产出**。
- 对产品防护的判定：
  - `baselineProvider.hasHaveRev` 的 `!== 'none'` 防护：**真机上不必要**（键缺席已被 `!info.haveRev` 挡住），但无害，保留作 belt-and-braces 无问题。
  - `p4StatusBar._renderRevInfo` 的 `haveRev === 'none'` 分支：**真机死代码**——真实 open-for-add 走 `have===undefined && head!==undefined` 分支显示 `#head`（如 `#4`，tooltip "Head revision 4"），而不是设计的「新增」徽标。见「产品问题清单」。
  - `timelineProvider.openDiff` 的 `if (haveRev) printRevision(depotFile#haveRev)`：唯一未做 `'none'` 防护的 `#spec` 拼接点。真机上 `haveRev` 缺席时走不到（fine）；若未来服务器真给 `'none'` 字符串会拼 `print ...#none`——低风险，见清单。
- 附带新字段（产品未消费，优化候选）：`workRev`、`actionOwner`、`otherOpen0/otherAction0/otherChange0/otherOpen`（fstat 自带「他人占用」信息，numbered 并行键形态）。
- `fstat -Mj` 结构化 ✓（唯一不塌的命令）。

### 10.5 状态栏 `#have / #head` 三种分支（G4）

| 分支         | 实测数据                         | 渲染                                                                                                    |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 正常         | fstat `haveRev=7 headRev=7`      | `#7 / #7`（不可点）✓                                                                                    |
| 落后         | fstat `haveRev=1 headRev=2`      | `#1 / ↓#2`（点击 syncLatest）✓                                                                          |
| open-for-add | fstat 无 `haveRev` 键（见 10.4） | 落到 head-only 分支显示 `#head` 或（全新文件 head 也缺席时）隐藏；**「新增」徽标分支在真机永不触发** ⚠️ |

### 10.6 切 client：`clients` 形态复核（G5）

- `-Mj clients -u <user>`：**塌陷** ✓（`{"data":"Client ... root ...","level":0}`，3 行全 data blob）；`-ztag` 字段大小写：**仅 `client` 小写**，`Update`/`Access`/`Owner`/`Options`/`SubmitOptions`/`LineEnd`/`Root`/`Host`/`Stream`/`Type`/`Backup`/`Description` 首字母大写 ✓——§5 全部确认。耗时 ~105ms。
- 只读边界说明：切换本身是**纯内存接线**（`switchClient.ts` 读源码确认：不跑 `p4 set`，只新建 provider + 改 active）→ 无写侧需要验证；未验证的只有编辑器内 UI 流（quick pick → 新 provider 生效），归下一组。

### 10.7 previewSync 记录形态（G6）

- 窄 scope：`depotFile` / `clientFile`（**本地路径**）/ `rev` / `action=updated` / `change` / `fileSize` / `totalFileSize` / `totalFileCount`——§1 字段确认，2 条记录 528 字节，126ms。
- 全部最新时：stdout 零记录、stderr `file(s) up-to-date.`、exit 0 ✓（`classifySyncError` 先于 exit 判定 stderr 的顺序是正确的）。

### 10.8 产品问题清单（仅汇报，本轮未改代码）

1. **[中] 默认 scope 下「他人占用」永不发布**：`runOpenedByOthersScan` 默认 scope `//...`，真机上 `-m 301` 的 others 全来自其他分支 → `where` 反查空 → `localByDepot.size===0` → keep previous → 计数/灰字恒为初值。建议：默认 scope 与 reconcile 同源收窄（聚焦目录），或对 `opened -a` 加分支内 filespec，或当 others 全视图外时至少发布「N files open by others (outside this workspace)」计数而不静默 keep previous。
2. **[中] `sanitizeEnv` 未剥 `PWD`**：见 10.1——从 POSIX shell 启动编辑器时 client 发现会连错 registry 默认 client。建议 `sanitizeEnv` 剥 `PWD`（p4 会回退 cwd，插件 spawn 时 cwd=clientRoot 已正确）。
3. **[低] 状态栏 open-for-add 的「新增」徽标是死代码**：fstat 不产 `'none'`，真实 open-for-add 显示 `#head`（甚至 re-add 场景显示已删文件的 head 版本，误导）。若要「新增」语义，判据应是 `action === 'add'`（fstat 有这个字段）。
4. **[低] `runOpenedByOthersScan` 每次多付一次 `-Mj` spawn**：`opened -a` 的 `-Mj` 在本服务器必塌，`execRecords` 每次白跑第一遍。既然已实测必塌，可直接 `execTagged`（同 `previewSync` 的取舍）。附带：CLAUDE.md「fstat/opened/changes 的 -Mj 正常」的记载需修正为「只有 fstat 结构化」。
5. **[低] `timelineProvider.openDiff` 未防 `'none'`**：真机不触发（键缺席），仅当未来服务器在 fstat 里真给 `'none'` 字符串时才会拼 `print #none`。
6. **[信息] 默认 scope 的落后检查在活跃服务器上每 5 分钟白付一次 20s `sync -n`**：depot 级 marker 约 6 分钟前移一次。非 bug（超时后保持旧值、下次重试），但说明「默认 scope 未收窄时，两级探针只省了『不活跃 depot』的钱」——聚焦目录才能兑现设计收益。

### 10.9 仍未验证（需写操作或编辑器内 UI，归下一组任务）

- 真 `sync`（写盘）、`reconcile`、自己 client 的 open-for-add 文件 fstat（需 `p4 add`，本轮只读）。
- 编辑器内 UI：灰字/落后装饰真实渲染、状态栏实时性、切 client 完整流、错误引导按钮的实际行为、后台扫描期间交互命令是否秒开（并发门预留槽真机验证）。
- 多 filespec 廉价门的「`-m 1` 每 filespec 各一条」形态未复测。

## 11. 2026-08-31 破坏性组（真 sync 写盘 + resolve 三档，一次性 temp client）

> 复跑脚本：`extensions/perforce/scripts/probe-real-sync.mjs`（入库，零依赖 Node；跑法见文件头）。
> 全部写操作发生在一个 throwaway client `tmp_probe_<pid>`（view = 窄目录 `//depot/branch_x/Package/Script/narrow_dir/...` + 两个单文件映射行）里，真实工作区 `X:/p4ws/main` **只读**；结束 revert → `shelve -d` → `change -d` → `client -d`（plain，非 admin 的 `-f` 实测被拒）→ 删 temp 目录，exit handler 兜底。**零 depot 写**（submit/integrate/obliterate 等一律拒绝执行）。本轮环境与前轮同一对服务器（P4D 2024.2 + P4P 2025.2）；temp client 是非 stream client（同 §1–§9 轮次）。所有真实 depot 路径 / 用户名已替换为占位值；实测数字保留。

### 11.1 sync 行形态 + parseSyncOutput 四计数（G1）

| 情形 | stdout 行（逐字形态） | stderr | exit | parseSyncOutput |
|---|---|---|---|---|
| 全新 client 初次 sync（1071 文件） | `<depot>#1 - added as <local>` | 空 | 0 | `applied=1071` ✓ |
| 再次 sync（无更新） | 空 | `<scope> - file(s) up-to-date.` | **0** | `upToDate=true` ✓ |
| `sync -f` 干净文件 | `<depot>#1 - refreshing <local>`（**无 `as`**） | 空 | 0 | `applied=1` ✓ |
| 开着的文件（have < head）sync | `<depot>#2 - is opened and not being changed` + `... <depot> - must resolve #2 before submitting` | 空 | 0 | `keptOpen=1 mustResolve=1` ✓ |
| clobber 拒绝 | `<depot>#2 - updating <local>` | `Can't clobber writable file <local>` | **1** | `applied=1` ⚠️ 见 11.8 |
| 开着的文件 `sync -f`（have 已被上一次 sync 提到 head 之后） | 空 | `<local> - file(s) up-to-date.` | 0 | `upToDate=true` |

- parseSyncOutput 对真机逐字文案全部命中：`added as` / `refreshing` / `is opened and not being changed` / `must resolve` / `file(s) up-to-date`。§2 的 `deleted as` / `updated as`（正常 update）行本轮场景未覆盖（窄目录无该情形），形态可信但**未实测**，列入未验证。
- **唯一偏差：clobber 拒绝行的 `- updating <local>` 被计入 applied**（该行与成功 update 逐字相同，失败信号只在 stderr + exit 1）——产品影响见 11.8，低危。

### 11.2 clobber 真机复现（G3）

- 逐字：stdout 先打 `<depot>#2 - updating <local>`，**stderr** 打 `Can't clobber writable file C:\...\CaseMismatchConfig.ini`，exit **1**。`classifySyncError` 的 `can't clobber writable file` 匹配实测 **MATCHES** ✓。
- **单个 clobber 中断整次 sync**（exit 1，不是 skip-and-continue）；混合批见 11.8。
- `sync -f` 覆盖本地草稿实测 **YES**（内容恢复为 depot head）——产品 `-f` 前的「覆盖本地文件、不可撤销」确认文案与真机行为一致。
- 产品链路顺藤验证：`sync()` exit≠0 → `classifySyncError` → kind=clobber → `runSync` 弹「Collect Changes」按钮 → `reconcile(targets)`——按钮动作与真机 clobber 语义（本地有未收集改动）对得上。

### 11.3 keptOpen 真机触发 + 双行形态 + resolve 被当场调度（G2 的关键）

- 触发条件真机确认：**文件 opened for edit 且 have < head 时 sync**，输出**两行**：`- is opened and not being changed`（常规行）+ `... <depot> - must resolve #2 before submitting`（提示行）——同一条 sync 里 `keptOpen=1 mustResolve=1` 同时命中。
- **与 fake-p4 模型的重大差异**：真机这个 keptOpen sync **当场调度了 resolve**——opened record 从 `rev=1 haveRev=1` 变成 `rev=2 haveRev=2`（haveRev 被 bump 到 head），`resolve -n` 显示 `- merging <depot>`。产品 toast 因此会显示「Updated 0 · 1 skipped (open for edit) · 1 need merging」+「Resolve Conflicts」按钮——**sync 侧 UX 在真机成立**。
- `sync -f` on opened：真机输出 `file(s) up-to-date.` exit 0（have 已被上一次 keptOpen sync 提到 head，`-f` 无事可做）——**fake-p4 的「force on opened → updates + needs-resolve」模型在真机不成立**。fake-p4 需改（已列入问题清单，未动）。
- sync on unresolved：真机 `file(s) up-to-date.` exit 0，无 mustResolve 行——parse 归 upToDate ✓。
- 附带：`p4 edit` 在 #N-1 打开落后文件时就打 `... must sync/resolve #2 before submitting` 警告（这是 edit 的警告，不是 sync 的输出）。

### 11.4 resolve 三档真机 transcript（G4）

真冲突态由「keptOpen 调度的 resolve + 本地改 head 也改过的同一行」制造（merge base = 打开时的 rev，零 depot 写）：

| 命令 | 状态 | transcript 逐字 | exit | parseResolveOutput |
|---|---|---|---|---|
| `resolve -n` | 真冲突 | `<local> - merging <depot>` | 0 | （产品不解析 -n 输出） |
| `resolve -am` | 1 conflicting | `merging` + `Diff chunks: 0 yours + 0 theirs + 0 both + 1 conflicting` + `<clientFile> - resolve skipped.` | **0** | `remaining=1`（SKIPPED_LINE 命中）；事后 fstat 仍带 `unresolved` ✓ |
| `resolve -am` | mergeable（S5a 形态） | `merging` + `Diff chunks: 1 yours + 1 theirs + 0 both + 0 conflicting` + `<clientFile> - merge from <depot>` | 0 | **`unrecognized=true`** ⚠️ |
| `resolve -am` | mergeable（本行已含 head 改动） | `merging` + `Diff chunks: 1 yours + 0 theirs + 1 both + 0 conflicting` + `<clientFile> - ignored <depot>` | 0 | **`unrecognized=true`** ⚠️；合并后本地=head+append ✓ |
| `resolve -ay` | 真冲突 | `<local> - vs <depot>#2` + `<clientFile> - ignored <depot>` | 0 | **`unrecognized=true`** ⚠️；本地=我方 ✓ |
| `resolve -at` | 真冲突 | `<local> - vs <depot>#2` + `<clientFile> - copy from <depot>` | 0 | `merged=1` ✓；本地=head ✓ |

- **KEY CLAIM 确认：`-am` 留下未解文件时 exit 0**（phase-5 前提成立；跳过不是失败，remaining 由 `resolve skipped.` 行计数）。
- **parseResolveOutput 真机适配缺口（重要）**：真机 transcript 的 `- merging` / `Diff chunks: ...` / `- merge from` / `- ignored` 四种行全部 unrecognized；只有 `- resolve skipped.`（→remaining）与 `- copy from`（→merged）被识别。**成功合并的 `-am`（最常见路径）在真机上报 unrecognized=true、merged=0**。
- 产品影响：`_runResolve` 在 connected 时走 authoritative 路径（用 `_unresolvedPaths` 算 remaining/merged，不读 text counts）——但见 11.5，那条路径本身在真机失效；离线 fallback（`text.merged`/`text.remaining`）在真机会把成功的 -am 报成「Resolve completed.」（漏报 merged）。次要（离线场景），见 11.10。
- `-ay` 语义真机确认：本地保留我方内容 ✓；`-at` 语义：本地变为 depot head ✓——与产品两档文案（「accept yours 丢弃 incoming / accept theirs 丢弃本地」）一致。

### 11.5 🔴 unresolved 信号：`opened` 没有，`fstat` 有——「需要合并」整条链在真机失效（头号产品发现）

- 在两个真实 unresolved 态（keptOpen-scheduled、改同一行的真冲突）里，`p4 -ztag opened` 的记录**都没有 `unresolved` 键**（keys 只有 depotFile/clientFile/rev/haveRev/action/change/type/user/client）；同一时刻 `p4 -ztag fstat` **有裸键 `... unresolved`**（实测 fstat keys 列表含 `unresolved`）。
- 产品链：`openedParser.ts` 的 `unresolved: record['unresolved'] !== undefined`（key 存在性）→ `client.ts` 的 `_unresolvedPaths` 与 pinned「需要合并」组 → `resolveChangelist` 的 candidates 过滤 → `_runResolve` 的 authoritative remaining/merged → sync 后「Resolve Conflicts」按钮的 merge editor 引导。
- **后果（P4D 2024.2 真机）**：
  1. 需要合并的文件在 SCM 视图**没有 U 徽标、不进「需要合并」置顶组**，与普通编辑行无差别；
  2. `resolveChangelist('default')` 的 candidates **恒为空** → 「Resolve Conflicts」按钮点的 `resolve -am` 命令本身照跑（能合的合了）后，`merged=0 remaining=0` → 弹「Resolve completed.」，**即使还有 conflicting 文件没解决**；
  3. `remaining>0` 分支（「{0} file(s) still need manual resolution」+ 打开 merge editor 的引导按钮）**永不触发**。
- 修法方向（仅汇报）：unresolved 信号改从 `fstat` 取（裸键 `unresolved`，真机实测存在；fstatParser 目前不消费该键），或跑 `resolve -n` 读 transcript；fake-p4 的 `opened` 现在 emit 的 `unresolved` 字段正是真机没有的形态——**e2e 假绿了整条真机死链**。

### 11.6 shelve+unshelve 不产生 resolve 态（S5c，附带发现）

- `p4 shelve` 不带 `-c` 会弹 CL spec 编辑器并**永久阻塞**（本机 P4EDITOR 恰是 node，弹出来直接崩溃）。脚本规避：`change -i`（stdin spec，零编辑器）+ `reopen -c <cl>` + `shelve -c <cl>`——产品 `newChangelist` 同款路径，产品无此问题。
- unshelve 一个 full-file-replacement shelf 到 head 上：`<depot>#1 - unshelved, opened for edit`；opened record `rev=1 haveRev=1`（**haveRev 被重置回 shelf 的 base rev**，即使 unshelve 前已 sync 到 #2）；`resolve -n` → `<local> - no file(s) to resolve.`。**unshelve 在本服务器不创建 resolve 态**——S5b 的真冲突因此改用 keptOpen + 同行编辑法制造。
- 附带实测：`client -d -f` 非 admin 被拒（`You don't have permission for this operation.`），plain `client -d` 可用；删 shelf 后须 `change -d` 删空 CL，否则空 pending CL 悬挂（产品 `deleteChangelist` 已有此序，无影响）。

### 11.7 open-for-add fstat：haveRev 键缺席（G5 结论）

- 自己 client 的 open-for-add，`fstat -ztag` 与 `-Mj`（生产路径）一致：`action=add`，**`haveRev` 键整个缺席**、全新文件 `headRev` 键也缺席；`opened` 记录才有字符串 `haveRev none`。
- **结论：`action === 'add'` 分支改动正确**——真机 fstat 里 add 的唯一可靠信号是 action 字段；`haveRev === 'none'` 的字符串在 fstat 永不出现（与 §10.4 一致）。两种输出模式（-ztag / -Mj）行为一致。

### 11.8 混合批：clobber 中断整次 run，且拒绝行被计入 applied（S7）

- 一次 sync 两个文件（A=opened 需 resolve、B=未签出本地改过）：stdout 三条（A 的 keptOpen + must resolve 两行、B 的 `- updating <local>`），stderr 单条 `Can't clobber writable file <B>`，**exit 1**——clobber 是**整批中断**（非跳过该文件继续），`classifySyncError` 整批归 clobber。
- parseSyncOutput：`applied=1 keptOpen=1 mustResolve=1`——**B 根本没被更新但计入 applied**（`- updating` 行与成功 update 逐字相同）。
- 产品影响：`sync()` 对 exit≠0 先走 `classifySyncError` 返回 error，`runSync` 错误路径不读 applied——**applied 误计对用户不可见**，仅日志里的 summary 虚高。低危。

### 11.9 与 §10 不一致 / 未验证

- 不一致（fake-p4 夹具 vs 真机）：① force-on-opened 的「updates + needs-resolve」在真机是 up-to-date（11.3）；② fake-p4 的 `opened` emit `unresolved` 字段，真机没有（11.5）；③ fake-p4 的 keptOpen 不 bump haveRev / 不调度 resolve，真机会（11.3）。
- 未验证：`- deleted as` / `- updated as`（正常 update）行形态（本轮窄目录无该场景，§2 前轮可信）；多文件批量 `resolve -am` 的 transcript；编辑器内 U 徽标 / 置顶组 / Resolve Conflicts 按钮的完整 UI 流（本组只验证了数据层信号与命令层行为）；`opened -ztag` 是否在任何条件下产出 `ourLock` 之类的替代信号（两次实测连 unresolved 键都没有）。

### 11.10 产品问题清单（仅汇报，本轮未改代码）

1. **[高] unresolved 信号链在真机失效**（11.5）：U 徽标 / 置顶组 / remaining 计数 / merge editor 引导全部依赖 `opened` 的 `unresolved` 键，真机从不产出；用户点了「Resolve Conflicts」后 conflicting 文件未解决却被告知「Resolve completed.」。建议从 fstat 裸键 `unresolved`（真机实测存在）或 `resolve -n` transcript 取信号。
2. **[中] parseResolveOutput 不认真机四种行**（11.4）：`merging` / `Diff chunks` / `merge from` / `ignored` 全 unrecognized，成功 -am 报 merged=0。authoritative 路径下影响被问题 1 掩盖；离线 fallback 与任何直接消费 counts 的代码会错报。
3. **[中] fake-p4 夹具与真机脱节三处**（11.9）：opened 的 unresolved 字段、force-on-opened 模型、keptOpen 不调度 resolve——e2e 假绿真机死链。夹具修改归下一任务（未动）。
4. **[低] clobber 拒绝行的 applied 误计**（11.8）：仅日志虚高，用户不可见。
5. **[信息] `p4 edit` 落后警告与 keptOpen sync 的 must-resolve 行共用同一文案**（`must sync/resolve #N before submitting`，11.3）——脚本与解析器的区分依据是前者出现在 edit、后者出现在 sync，无产品影响。

## 12. 2026-08-31 体验组（真实用户工作区整机实测：交互读 / 计数延迟 / 灰字与截断 / 引导边界）

整机验证：Playwright `_electron` 跑打包产物（`apps/editor/out/main/index.js`）+ 临时 user-data-dir，经 `openWorkspace` 探针打开真实用户工作区（`X:/p4ws/main`，stream client `testclient`，P4D 2024.2 + P4P 2025.2）。工作区自带用户自己的 workspace 层 settings（focus 三目录 + `perforce.autoRefresh: false`），零 opened 文件。脚本：`extensions/perforce/scripts/probe-real-experience.mjs`（C1 / C1b / C2 / C3a / C3b 五个场景，跑法与安全边界见文件头；真实 depot/账号值只出现在脚本本地输出，本文一律占位）。

### 12.0 启动方式与两条探针路径注意事项

- **为什么不用位置参数启动**（产品问题 12.5-2）：dev 模式 main 的 `parseFileToOpen` 假定 argv[1] 是 main script（`argv.slice(2)`，cliArgs.ts）；Playwright 在 app 入口前注入 `--inspect=0 --remote-debugging-port=0` → `out/main/index.js` 自己被当成待打开文件、文件夹参数被丢弃 → 每个窗口都以 `workspace=<none>` 打开（多轮 window.log 验证）。故脚本 boot 空窗口后经 `openWorkspace` 探针开工作区，等待 renderer pin + 扩展宿主 re-pin 双落定。
- **probe 路径的 project-layer 竞态**（产品问题 12.5-3）：boot 后 openWorkspace 时，`<dir>/.universe-editor/settings.json` 的绑定与扩展宿主读配置存在竞态——实测 5 轮命中 2 轮 focusEnabled 读成 false（sync scope 回退打开文件夹 → 整个工作区 sync -n 撞 20s watchdog → 计数不发布）。探针以 closeWorkspace+reopen 重试收敛（`ensureProjectLayer`）。正常用户路径（窗口创建时 restoreCurrent 在 loadURL 前）不受影响；「新窗口打开文件夹」的用户路径可能踩同一竞态。
- 本工作区真实 focus 三目录（绝对路径只在脚本本地输出出现）：TS（客户端脚本目录，259 behind）、kV（配表目录，1644 behind，含 5342 子项的最宽目录）、Cfg（配置目录，0 behind）。

### 12.1 C1：后台扫描在飞时的交互读（预留槽真机验证）+ fstat -Ru 成本

**12.1.1 C1b——确定性 20s 飞行（Package 子树当工作区）**

- 前提：该子树 `sync -n -m 501` 实测 **7min 1.8s**（501 记录封顶）→ 无 focus 配置时 sync scope = 打开的文件夹 = 该子树 → behind-check 的 sync -n 必然撞 20s watchdog，飞行窗口确定性成立。
- 时间线（从 launch 起）：first refresh +3.77s → gate（`changes -m 1 -s submitted <子树>/...`）+3.77s → `sync -n -m 501 <子树>/...#head` 在飞 +3.77s → **watchdog kill +23.9s**（`timed out after 20000ms; killing`）→ behind 计数从未发布（保持旧值、下个 interval 重试）✓。
- **在 20s 飞行窗口内的 openChange 读（fstat+print+read 三连）：247 / 248 / 40 / 37ms，全部亚秒**；空闲基线 134 / 129 / 35ms——在飞不比空闲慢（fstat 缓存 TTL 吸收重复读）。
- **queued-slot 日志 0 条**——预留槽真机验证：background sync -n 占满后台额度时，交互读从未排队（CLAUDE「共享 FIFO 并发门被大扇出灌满」的修复在真机成立）。
- 附带确认：默认（无 focus）scope 下每次检查白烧 20s + 杀进程（§10.2 同款行为，此处经整机在飞验证）；kill 后产品正确 keep previous result 而非误报 0。

**12.1.2 C1a——fstat -Ru 真机成本 + 真实 focus scope 的 marker 驱动 cycle**

- **fstat -Ru 的 refresh 增量成本：260ms**。零 opened 时 refresh stages `opened=242ms changes=307ms`；签出 1 个文件后 `opened=251ms changes=309ms unresolved=260ms`（`unresolved` stage = fstat -Ru 探针，命令 `p4 -ztag fstat -Ru //...`）。用户点击的整次 refresh 墙钟 1128ms——**探针对刷新总时长的影响可忽略**，且带 20s 紧超时 + background 优先级（在飞时不占交互预留槽）。
- marker 驱动的 behind-check cycle（8min 观察窗）：期间无人提交 → depot marker 未动 → sync -n 按设计被 gate 跳过、**从未在飞**（watchdog 未触发，符合设计）。在飞读改对 refresh fan-out 采样：openChange **258/247/59ms** vs 空闲基线 128/142/42ms——fan-out 在飞时点击读仍亚秒；openChange breakdown 两轮 fstat≈99ms / print≈102ms / total≈201ms（第三轮缓存命中 0ms）。cycle 全程 **queued-slot 日志 0 条**（预留槽在 refresh fan-out 场景下同样成立）、busy 标签 NONE、状态栏 `462 files behind` 与 discovery 产品形态一致。真实 20s 飞行窗口的交互读数据以 12.1.1（C1b）为准。

### 12.2 C2：状态栏「N files behind」端到端延迟

- 真实 focus 三目录，从 workspace open 起：first refresh **+2.1s** → cheap gate（`changes -m 1 -s submitted`）+2.1s → sync -n 在飞 +2.1s → **计数出现 +6.2s**（`$(cloud-download) 462 files behind`）。其中 sync -n（3 filespec 一条命令）占 ~4.1s。
- 结论：focus 收窄下计数 sub-7s 出现、UI 全程不阻塞；对照 12.1.1 的默认 scope（>20s watchdog、计数永不出现），聚焦目录的体验收益直接可见。

### 12.3 C3：灰字渲染与 500/300 截断

**12.3.0 🔴 产品发现（12.5-1）：`sync -n -m` 的截断量语义（受控矩阵复核，2026-08-31）**

**复核缘起**：初版结论「`#head`+多 filespec 触发 per-filespec 截断、截断量 = 501−前一 filespec 的 totalFileCount」在协调者用 `-f` 的组合下复不出来（所有组合都精确等于 `-m`）。故做受控矩阵：同一时刻、真实 scope、只改一个变量。TS=客户端脚本目录（297 文件 / 259 落后），kV=配表目录（1644 文件 / 1644 落后），Cfg=配置目录（1 文件 / 0 落后）。

| # | argv（`p4 -ztag sync -n` 后缀，无 `-f`；全部 exit 0、stderr 空） | 记录数 | totalFileCount 行 |
|---|---|---|---|
| 1 | `<TS>/...#head` | 259 | `297` |
| 2 | `<kV>/...#head` | 1644 | `1644` |
| 3 | `<TS>/...#head <kV>/...#head` | **1903** | `1941` |
| 4 | `-m 501 <TS>/...#head <kV>/...#head`（=产品形态） | **463** | `1941` |
| 5 | `-m 501 <kV>/...#head <TS>/...#head`（换序） | **463** | `1941` |
| 6 | `-m 100000 <TS>/...#head <kV>/...#head` | **1903** | `1941` |
| 7 | `-m 501 <kV>/...#head`（单 filespec） | 501 | `1644` |
| 8 | `-m 1000 <TS>/...#head <kV>/...#head <Cfg>/...#head`（三 filespec） | 961 | `1942` |

- **判据（#6）**：`-m 100000` 拿到完整 1903 → **问题就是 `-m` 的截断量语义**，不是 filespec 重叠去重 / 状态漂移 / 别的上限。且 #3 一条命令无 -m（1903）与三条单跑相加（259+1644+0）口径一致 → 463 与 1903 是**同形命令、同一时刻、只差 `-m`** 的受控对照，可比。
- **机制（P4D 2024.2）**：`-m N` = 最多**扫描 N 个文件**，跨 filespec 依次扣除「潜在文件数」（= totalFileCount，**含 up-to-date**）——TS 消耗 297 名额（259 落后 + 38 up-to-date），剩 204 给 kV → 落后记录 259+203/204 ≈ 463。**up-to-date 文件消耗名额但不产生记录**，这才是 463 < 501 的原因。单 filespec（#7）与协调者的 A,B 组合（`-f` 强制全落后，每个名额都产出记录）下记录数精确等于 `-m`——**同一机制的两个投影**；协调者复不出来是因为 `-f` 抹掉了 up-to-date 损耗，不是 `-m` 语义因 scope 而异。
- **与顺序无关为真，但归因修正**：服务器按 depot 序分配名额（#4/#5 均 TS=259、kV≈203），与 argv 顺序无关。初版「换序 204+259」的分解与「501−前一 filespec totalFileCount」公式是数值巧合下的错误归因，作废。
- **`totalFileCount` 截断时仍报真实潜在总数**（#4=1941；协调者组合 501 记录/totalFileCount=1075 同款）——但它含 up-to-date（1941 vs 真实落后 1903，本例高估 ~2%），**不能直接当落后计数**，作「扫描是否被截断」的信号则完全可靠。
- **附带实测：`-m` 在此 scope 上不省时**——#3（无 -m）2171ms vs #4（-m 501）2285ms vs #6（-m 100000）2292ms：服务器枚举成本相同，`-m` 只省输出行数。
- **产品影响**：① 状态栏 463（三 filespec 时 462）files behind 低估 ~4.1×；② 产品 cap 判定 `records > 500` 永不成立（463 < 501）→「count-only + loud log」的降级设计在真实用户配置上失效；③ 只有 ~463 个文件有「update available」灰字，其余 ~1440 个真实落后文件无任何标记也不进计数。与「`-m 501` 饱和即触发 cap」的设计假设不符。
- **修法方向（更新）**：cap 判定改读 `totalFileCount > SYNC_PREVIEW_MAX_DECORATIONS`（截断时仍报真实总数，零额外命令）；精确落后计数与装饰样本可一条无 -m 命令同时拿到（#3 与 #4 同耗时，输出 1903 条由流式解析截断控制）——比「分 filespec 逐条跑」更便宜。

**12.3.1 C3a 灰字在大目录（真实 focus scope，uncapped 462）**

- 数据层：462 个 behind 文件全部带「update available」灰字（8/8 抽样 ✓，tooltip 含真机 action/rev：`deleted #1` / `updated #653` / `updated #40` 等）；3/3 落后清单外的 up-to-date 文件无装饰（无假灰字）✓。
- 大目录滚动：focus 内最宽目录（kV 树下）**5342 个直接子项**。打开其中文件经 ExplorerAutoReveal 自动展开全部祖先；该目录 0 灰字（实测该目录确实零 behind 文件，正确）。6×PageDown / 6×PageUp 滚动：**4551ms、13 次交互、0 慢交互**（>200ms 阈值）——几千行虚拟列表滚动不卡顿 ✓。
- **正向灰字渲染 ✓**：behind 最密集目录（49 个 behind，kV 树下）reveal 后 Explorer DOM **32 行渲染、5 行带「update available」灰字**——灰字在真实大目录中正确渲染（视口内 5 行，其余 behind 分布在目录内视口外）。

**12.3.2 C3b 截断行为（真实 focus scope）**

- **others 301 截断（真实 746）**：loud log ✓——`opened-by-others: more than 300 files open by others; showing the count only, no per-file markers` + `opened-by-others: 300+ file(s)`，**不静默**。per-file others 灰字全部清空（6 个 where 翻译样本 4/6 干净；其余 2 个同时是 behind 文件、仍显示 behind 灰字——正确，cap 只清自己那一类）。
- **behind 500 截断：真实配置不可达**（产品形态恒 462 < 501，根因见 12.3.0）；单测 + fake-p4 e2e 已覆盖 cap 代码路径，真机 UI 层未触发——如实记录。
- 状态栏同屏：`Focus: 3 folders` + `462 files behind` + client 名 + 0 opened，无冲突。

### 12.4 C4：错误引导链边界

- clobber →「Collect Changes」→ reconcile(targets)：命令层已在 §11.2 真机验证（stderr `Can't clobber writable file` 逐字匹配 `classifySyncError`；sync exit 1 → classify → `runSync` 弹按钮）。
- 按钮的真机点击需要一次真实 clobber（写 sync）——按红线不在真实工作区执行；B 组临时 client 已验 stderr 形态与产品链路，但**整机 UI 按钮点击未验证**，如实记录。

### 12.5 产品问题清单（本轮新增，仅汇报）

1. **[高] `sync -n -m 501` 的截断量语义 → 落后计数低估 ~4.1× + cap 判定失效**（12.3.0，受控矩阵复核）。机制：`-m` 限制**扫描文件数**（含 up-to-date 损耗），非落后记录数——本用户 focus scope 实测 463 vs 真实 1903；`-m` 全局封顶外观只在 scope 内无 up-to-date 损耗时成立（协调者 `-f` 组合、单 filespec 全落后组合均精确等于 `-m`，两种观察是同一机制）。修复方向（仅建议）：cap 判定改读 `totalFileCount`（截断时仍报真实潜在总数，零额外命令）；精确计数可一条无 -m 命令同时拿到（同耗时）。
2. **[中] dev 模式 `parseFileToOpen` 假定 argv[1] 是 main script**（12.0）：任何在入口前注入 argv 的启动器（Playwright、调试器）都会吞掉文件夹参数；dev 模式文件关联打开同样受影响。打包版（isPackaged）走 `slice(1)` 无此问题。
3. **[中] boot 后 openWorkspace 的 project-layer 竞态**（12.0）：扩展宿主可能读到 focus 默认值 → sync scope 回退打开文件夹 → 大工作区每 interval 白烧 20s + 计数不发布。探针路径 5 轮命中 2 轮；用户「新窗口打开文件夹」路径可能踩中。正常启动路径不受影响。
4. **[信息] 无 focus 配置时打开文件夹 scope 下 behind-check 每 interval 白烧 20s**（12.1.1 整机在飞验证）：设计内（超时保持旧值、下轮重试），但与 §10.2 一致地说明默认配置下两级探针只省「不活跃 depot」的钱。

### 12.6 与 §10/§11 不一致 / 修正

- §10.2 的「默认 scope = `//...`」：产品接线里 `setSyncScope` 唯一调用点恒传「focus dirs 或打开文件夹」，`['//...']` 兜底不可达——「默认 scope」实际是**打开的文件夹**（用户打开 client 根时语义等价）。
- §10.2 的「窄 scope sync -n ≤130ms」：focus 多 filespec 单命令实测 2.2s（462 记录）、单目录 0.4–1.7s——scope 规模不同，补充典型值而非矛盾。
- A 组（§10）记录的产品计数 462 与真实 1903 的对照首次在本轮建立（A 组未做无 -m 对照），并已通过 12.3.0 受控矩阵复核（同形只差 `-m`：463/1903，`-m 100000` 恢复 1903）。

### 12.7 未验证

- C4 的 UI 按钮点击（需写 sync，红线外）。
- behind >500 cap 的真机 UI（真实配置恒 462，见 12.3.0）。
- 状态栏「Resolve Conflicts」引导的整机点击（需 unresolved 状态，B 组已验数据层 §11.5）。
- fstat -Ru 的 20s 超时路径（真实工作区 opened 数量少，探针亚秒完成）。

### 12.8 运行记录（原始数字，供追溯）

- C1a（真实 focus + 1 个授权签出文件，try/finally revert）：`p4 edit` 146ms；fstat -Ru stage 260ms / 整次 refresh 1128ms；marker 8min 未动 → sync -n 未在飞（watchdog 未触发）；fan-out 在飞读 258/247/59ms vs idle 128/142/42ms；queued 0 条；`p4 revert` exit 0（`was edit, reverted`）+ `p4 opened` 复核干净（final 0 files open）。
- C1b（Package 子树工作区）：gate/sync -n 在飞 +3773ms；在飞读 247/248/40/37ms；idle 134/129/35ms；watchdog kill +23948ms；queued 0 条；behind 计数未发布 ✓。
- C2（真实 focus）：first refresh +2121ms / gate +2124ms / sync -n +2125ms / 计数 +6248ms（'462 files behind'）。refresh stages：opened=269ms changes=320ms shelved=0ms unresolved=0ms reconcile(none)=1ms（两轮同构）。
- C3a：8/8 behind 灰字 ✓、3/3 up-to-date 无装饰 ✓、最宽目录 5342 子项滚动 4389–4551ms/13 交互/0 慢交互；behind 密集目录（49 behind）reveal 后 32 行渲染、5 行带灰字 ✓。
- C3b：others cap log ✓（+~2.8s 出现）、behind cap 不可达、others 样本 4/6 干净、状态栏 `Focus: 3 folders | 462 files behind | testclient 0`。
- 探针路径竞态命中率：5 轮 launch 中 2 轮首开 focusEnabled=false，close+reopen 后 100% 收敛。
- 12.3.0 受控矩阵复核（2026-08-31，同一时刻、真实 scope、只改一个变量）：单 TS#head 无 -m=259/totalFileCount 297；单 kV#head 无 -m=1644/1644；双 filespec 无 -m=1903/1941；`-m 501` 双 filespec=463/1941（产品形态）；换序=463/1941；`-m 100000`=1903/1941；单 kV `-m 501`=501/1644；三 filespec `-m 1000`=961/1942。耗时：无 -m 2171ms vs `-m 501` 2285ms vs `-m 100000` 2292ms（`-m` 只省输出不省枚举）。
