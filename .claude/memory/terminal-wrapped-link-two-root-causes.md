---
name: terminal-wrapped-link-two-root-causes
description: 终端跨折行文件链接失效有三个独立根因(conpty 无 wraparound 未透传 windowsPty + provideLinks 返回越行链接被 xterm 剔除 + 窗口字符串 trimRight 拼但坐标映射走完整网格)
metadata:
  node_type: memory
  type: project
---

终端里超出末列、折到下一行的文件路径点不开。提交 `64824ed3` 只做了「拼接折行窗口」那一半,**实际完全没生效**——真因是**三个各自独立、单独存在就足以让功能失效或画错**的缺陷,必须同时修:

**① Windows conpty(<build 21376) 没有 wraparound 模式,pty 后端从未告知 xterm。**
超出末列的行以硬 `\r\n` 到达,缓冲行的 `isWrapped` **永远为 false**;而 `terminalBufferText.ts` 的 `readWrappedWindow`(照抄 addon-web-links)完全依赖 `isWrapped`,折行窗口根本拼不起来,路径连匹配都匹配不到。xterm 对此有专门启发式(`WindowsMode.ts` 的 `updateWindowsModeWrappedState`:每次换行时若上一行末格非空白就给下一行打 `isWrapped`),但**只有构造 `Terminal` 时传了 `windowsPty: {backend, buildNumber}` 才启用**(`CoreTerminal._handleWindowsPtyOptionChange`,阈值 `backend==='conpty' && buildNumber<21376`,`Buffer._isReflowEnabled` 同阈值)。
修法:pty 后端属于**spawn 它的那台主机**(远程工作区就是远端机器),所以必须随 `ITerminalCreatedInfo.windowsPty` 经 IPC 透传,而不是在 renderer 读 `process.platform`。`PtyHostService` 按 node-pty 自己的 `>= 18309` 规则派生 backend;`TerminalXtermHolder` 在**构造函数**里取(不能构造后赋值,`attach` 紧接着就 flush 缓冲输出)。

**② `provideLinks(y, cb)` 违反 xterm 隐含契约:只能返回与第 y 行相交的链接。**
它当时把折行窗口内**所有**匹配都返回,包括完全落在别的行上的链接。`Linkifier._removeIntersectingLinks` 会把每条返回的链接**投影到被 hover 的那一行**(`start.y < y` ⇒ x=0,`end.y > y` ⇒ x=cols)后先到先占,越行链接从 x=0 起必然与同样从 x=0 起的跨行链接撞车,被 `splice` 出 `_activeProviderReplies`。所以真正想要的那条折行链接被删掉、点不开。
判定末行时注意 `end.x === 0` 表示链接正好停在列边界上,它的最后可见行是 `end.y - 1`。

**③ 窗口字符串用 trimRight 拼,坐标映射却走完整单元格网格。**
`readWrappedWindow` 每行用 `translateToString(true)`(**trimRight**,照抄上游),而 `mapStringIndexToCell` 遍历 `for (i = start; i < line.length; ++i)`——**包含被裁掉的行尾 NULL 格**。这些格 `getChars()===''`、`getWidth()===1`,命中 `stringIndex -= chars.length || 1` **每格白扣一个字符串字符**,range 整体左移并塌成单行;xterm 的 `_setCellUnderline` 只钳制 y 不钳制 x,于是下划线从偏左处一路划到行末、第二行那段根本不存在。上游 `@xterm/addon-web-links@0.12.0` 的 `WebLinkProvider.ts:108-110` 自己写明了这个危险("**This corrupts the string index for 1:1 backmapping to buffer positions**"),但它的 correction **只覆盖「宽字符提前折行」一种情形**。
修法:算出每行「参与了字符串的格子数」(等价 xterm 内部 `getTrimmedLength()`,公开 `IBufferLine` 不暴露须自己从行尾往前扫;**尾随宽字符要算 2 列**,即 `i + (getWidth() || 1)` 而非 `i + 1`),只对 `i < trimmed` 的格扣 `stringIndex`。修好后上游那段「宽字符提前折行 +1 回补」成为冗余可删。

**③ 的连带坑:「找字符」与「找排他末位」在行边界上是两种语义,必须显式区分。**
`mapStringIndexToCell` 被 start(找真实字符)与 end(找排他末位)共用。当 stringIndex 恰在某行内容边界耗尽、该行**有 padding**、且**下一行是 wrapped** 时:start 应落到下一行 cell0(字符确实在那),end 应落到本行的 `trimmed`。旧实现靠「多走一格 padding 让 index 转负」自然区分,裁剪掉 padding 消耗后这个天然区分**消失了**,只按 `next?.isWrapped` 猜会把 end 多推一行 → 下划线又从起点划到头行末尾(与根因③同型症状)。修法是加 `target: 'char' | 'exclusiveEnd'` 参数显式表达,别在边界上猜。这个坑**只在「padded 行 + wrapped 后继行」同时成立时触发**,前一版修复的测试恰好只覆盖了「后继行非 wrapped」,零覆盖。

**③ 与 ① 的因果**:干净缓冲区里 ③ 打不着——一行之所以 `isWrapped` 正是因为它被填满、没有行尾 NULL 格。**但 ① 打开的 Windows 折行启发式改变了这个前提**:`WindowsMode.updateWindowsModeWrappedState` 是按「上一行末格非空」来**猜**,而 conpty 频繁 erase-to-end-of-line 重绘会留下「被标 wrapped、行尾却是 NULL 格」的行。**修了 ① 才引爆潜伏的 ③**,这也是它只在 Windows 真实终端上出现的原因。

**Why**:三处都极隐蔽,且**绕过 `Linkifier` 的纯 provider 单测对 ①② 都会假绿**——它们把 `Terminal` mock 成 `{buffer:{active:...}}` 直接调 `provideLinks()`,既不经 xterm 的剪枝,也不经真 pty 的 `isWrapped` 行为。而 ③ 反过来:**e2e 结构上复现不了它**(见下),只有单测能。
**How to apply**:改终端链接必须配真 Electron + 真 pty + 真鼠标的 e2e(`smoke.terminalLink.spec.ts`,`@regression`);让指针**先落在该行空白尾巴再移到路径上**是必要的,那才会让 xterm 读已被剪枝的缓存而非重新询问。**e2e 必须断言 range 本身而不只是「打开了正确文件」**——range 塌成单行时链接照样能激活、照样打开对的文件,只有下划线画错,断言打开结果对整类渲染错误免疫(探针 `terminalProvideLinks(id,row)` 直接问活的 provider 要 range)。定位这类「修了但没生效」时,逐一 revert 各修复验证其必要性,别假设只有一个根因。关联 [[opener-service-deeplink-feature]]、[[largefile-reveal-dirtydiff-vscode-parity]]。

**测试反面教训(③ 专属)**:
- `makeTerminalBuffer` 把文本**紧密排布**、每行恰好填满,**结构上无法**产生行尾 NULL 格——跨行用例必须同时覆盖 `makeBufferFromLines`(会 `padToCols` 补 NULL 格且允许显式指定 `isWrapped`)。
- **e2e 也复现不了 ③**:xterm 只在「**上一行**末列非空」时才标 wrapped,所以单次 `echo` 输出的头行必然是满的。已实测验证:把 `trimmedLength` 退回成 `line.length`(等价旧的全网格遍历)后,**e2e 仍然绿、单测红 4 条**。所以 ③ 的复现只由单测承担,e2e 的 range 断言是跨行几何(①②)的守护 + 整类渲染错误的可见性来源,别把它当成 ③ 的回归门。
