---
name: monaco-addcommand-global-key-leak
description: "standalone Monaco 的 addCommand 注册在共享键位服务(无编辑器作用域),会在所有 Monaco 编辑器触发→吞键跨编辑器泄漏"
metadata: 
  node_type: memory
  type: project
  originSessionId: 048b0bef-4c30-40e0-8e2b-e957dfb5f41f
---

ACP 输入框(PromptMonacoEditor)曾用 `ed.addCommand(m.KeyCode.Enter, …)` 绑定回车提交。**坑**:standalone Monaco 的 `addCommand` 注册在 Monaco **共享的 StandaloneKeybindingService** 上,**没有编辑器作用域**——于是在**任意** Monaco 编辑器里按 Enter 都会触发 prompt 的 onEnter(提交/no-op),把回车吞掉。

**现象**(用户必现 bug):打开文件夹 + hello.ts,回车能换行;打开/恢复一个 session editor(令 prompt Monaco 挂载并注册全局 addCommand)后切回 hello.ts,回车失效。`.md` 免疫是假象——markdown 有更高权重的 `markdown.editing.onEnter`(weight 300)在全局键位分发器层先认领 Enter,`.ts` 依赖 Monaco 默认 Enter 才被劫持。

**修法**:把 Enter 处理从 `addCommand` 挪到编辑器**自己 DOM 节点上作用域化的 capture keydown 监听**(与既有 ArrowUp/Tab 处理同址,`dom = ed.getContainerDomNode()` + `addEventListener('keydown', h, true)`)。onEnter 返回 false 时**不 preventDefault**,自然落到 Monaco 原生 Enter 插入换行(旧代码显式 `trigger type \n`,新代码靠 fall-through)。

**通用教训**:standalone Monaco 里凡是"只该在本编辑器生效"的键位,一律走**作用域化 DOM keydown**,**绝不用 `editor.addCommand`**(它是全局的)。同家族见 [[editor-text-focus-stuck-swallows-keys]](另一种 Monaco 吞裸字符键)。

守护:e2e `smoke.agentsPromptEnterLeak.spec.ts`(@regression,@p1)——开 .ts 按 Enter→开 session editor→切回 .ts 断言 Enter 仍插换行;已验证旧代码下该 spec 正确失败。
