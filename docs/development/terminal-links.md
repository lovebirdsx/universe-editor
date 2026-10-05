# 终端跨折行文件链接

终端里超出末列、折到下一行的文件路径点不开。真因是**三个各自独立、单独存在就足以让功能失效或画错**的缺陷，必须同时修——提交 `64824ed3` 只做了「拼接折行窗口」那一半，**实际完全没生效**。

三处根因的机制论证已在原地成文（下表锚点即契约），本文只记**跨模块因果、上游 xterm 坐标、以及代码里没有的残项**。

| # | 根因 | 锚点 |
|---|---|---|
| ① | Windows conpty（< build 21376）没有 wraparound 模式，pty 后端从未告知 xterm → 折行窗口根本拼不起来 | `apps/editor/src/renderer/services/terminal/TerminalXtermService.ts:201-210`、`packages/node-services/src/terminal/ptyHostService.ts:167-179` |
| ② | `provideLinks(y, cb)` 的隐含契约=只能返回与第 y 行相交的链接；越行链接会被剪枝后先到先占 | `apps/editor/src/renderer/workbench/panel/terminal/terminalLinkProvider.ts:65-79` |
| ③ | 窗口字符串按 trimRight（`translateToString(true)`）拼，坐标映射却走完整单元格网格 → range 左移并塌成单行 | `.../terminal/terminalBufferText.ts:74-86` |
| ③′ | 同一映射函数被 start（找真实字符）与 end（找排他末位）共用，行边界上语义不同 | `CellTarget` doc comment（`terminalBufferText.ts:88-101`） |

## 上游 xterm 坐标（排查时直接去 node_modules 读）

- ① 的启发式是 xterm 自己的 `WindowsMode.updateWindowsModeWrappedState`——**只有构造 `Terminal` 时传了 `windowsPty: {backend, buildNumber}` 才启用**（`CoreTerminal._handleWindowsPtyOptionChange`；阈值 `backend === 'conpty' && buildNumber < 21376`，`Buffer._isReflowEnabled` 同阈值）。
- ② 的剪枝在 `Linkifier._removeIntersectingLinks`（把返回的每条链接**投影到被 hover 的那一行**：`start.y < y ⇒ x=0`、`end.y > y ⇒ x=cols`，再先到先占）。
- ③ 的下划线绘制是 `_setCellUnderline`——**只钳制 y，不钳制 x**，所以坏的 range 会一路划到行末。
- 上游 `@xterm/addon-web-links@0.12.0` 的 `WebLinkProvider.ts:108-110` 自己写明了这类映射的危险（"This corrupts the string index for 1:1 backmapping to buffer positions"），但它的 correction **只覆盖「宽字符提前折行」一种情形**——我们修好 ③ 后，照抄来的「宽字符提前折行 +1 回补」变冗余可删。

## 只有踩过才知道的残项

- **pty 后端属于 spawn 它的那台主机**（远程工作区=远端机器），所以 `windowsPty` 必须随 `ITerminalCreatedInfo` 经 IPC 透传，**别在 renderer 读 `process.platform`**；`PtyHostService` 按 node-pty 自己的 `>= 18309` 规则派生 backend（`ptyHostService.ts:179`）。`TerminalXtermHolder` 必须在**构造函数**里取（不能构造后赋值——`attach` 紧接着就 flush 缓冲输出）。
- **③ 的等价物是 xterm 内部 `getTrimmedLength()`**，公开的 `IBufferLine` 不暴露它，须自己从行尾往前扫；**尾随宽字符要算 2 列**（`i + (getWidth() || 1)`，不是 `i + 1`）。
- **①→③ 的因果**：干净缓冲区里 ③ 打不着——一行之所以 `isWrapped` 正是因为它被填满、没有行尾 NULL 格。**但 ① 启用的 Windows 启发式改变了这个前提**：它按「上一行末格非空」来**猜** wrapped，而 conpty 频繁的 erase-to-end-of-line 重绘会留下「被标 wrapped、行尾却是 NULL 格」的行。**修了 ① 才引爆潜伏的 ③**，这也是它只在 Windows 真实终端出现的原因。
- **实测数字**：把 `trimmedLength` 退回 `line.length`（等价旧的全网格遍历）后，**e2e 仍然绿、单测红 4 条**。

## 测试盲区互补（两侧都不可省）

- 纯 provider 单测（mock `Terminal = {buffer:{active}}` 直接调 `provideLinks`）**绕过 xterm 剪枝与真 pty 的 `isWrapped` 行为，对 ① ② 假绿**。
- ③ **反过来只有单测能复现**：xterm 只在「上一行末列非空」时才标 wrapped，单次 `echo` 输出的头行必然是满的，e2e 结构上做不出「标 wrapped 却行尾 NULL」的行。
- 测试基建反面教训：`makeTerminalBuffer` 把文本**紧密排布**、每行恰好填满，**结构上无法**产生行尾 NULL 格——跨行用例必须同时覆盖 `makeBufferFromLines`（`padToCols` 补 NULL 且可显式指定 `isWrapped`）。锚：`terminalFakeBuffer.ts:103/154`、`terminalLinkProvider.wrapped.test.ts:176-194`。

## 改这里必须走的验证流程

- 必须配**真 Electron + 真 pty + 真鼠标**的 e2e（`apps/editor/e2e/specs/smoke.terminalLink.spec.ts`，`@regression`）；让指针**先落在该行空白尾巴、再移到路径上**是必要的——那才会让 xterm 读已被剪枝的缓存，而非重新询问。
- **必须断言 range 本身**（探针 `terminalProvideLinks(id, row)`），不能只断言「打开了正确文件」：range 塌成单行时链接照样能激活、照样打开对的文件，只有下划线画错——断言打开结果对整类渲染错误免疫。
- 定位「修了但没生效」时**逐一 revert 各修复验证其必要性**，别假设只有一个根因（本主题就是「两个根因」的初判漏掉第三个的产物）。
