---
name: renderer-crash-log-feedback-loop-blackscreen
description: 长任务跑 agent 时窗口变黑(可拖动)不自愈的根因=渲染崩溃后主进程日志正反馈死循环
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d28f74d-f67d-4ca0-ad4c-c9a2a3f4553e
---

**现象**：编辑器跑 claude code 长任务时窗口变黑但可拖动 = 主进程存活、渲染进程崩溃。崩溃后 `console.log` 疯狂轮转(几秒一个 10MB,1h40m 写爆 500MB+)、打满 CPU,窗口永不自愈。

**根因(次生灾害,日志正反馈死循环)**：渲染帧销毁后主进程仍 `webContents.send`→Electron 33 对 disposed frame 的 send **不抛异常而是内部 `console.error("Error sending from webFrameMain")`**→被 main 的 `installConsoleInterceptor` 写进 console 通道→`FileLogger._doFlush→_fireAppend→onDidAppendEntry`→`LogFilesMainService` 经 ChannelServer 又 `ElectronProtocol.send` 推回死帧→再失败→再 console.error→无限循环。栈顶栈底完全吻合。关键坑：`electronProtocol.ts` 原有的 `try/catch`+`isDestroyed()` **拦不住**——disposed frame 时 `isDestroyed()` 仍 false、`'destroyed'` 事件不触发、send 也不抛。

**修复(三层)**：
1. `ElectronProtocol` 加 `_frameAlive` 闸门:监听 `render-process-gone`/`did-start-loading`(置死)+`dom-ready`/`did-finish-load`(恢复),send 前判断,从源头断循环;send 抛异常也翻闸。`webContents.on/removeListener` 重载多签名,须包成 `{on(e:string,h:(...a:unknown[])=>void):void}` 保 `this` 绑定(勿解构成变量调用,会丢 this)。
2. `windowMainService.createWindow` 监听 `render-process-gone`,非 `clean-exit` 弹 dialog 一键 reload,`_crashHandled` set 防抖(closed 时清)。
3. `FileLogger` rotate 突发熔断(10s 内≥3 次 rotate→抑制 `_onChunk` 30s,文件继续写盘但不再 fire onDidAppendEntry 往渲染推),防复发。`localize` 第三参是 `Record<string,unknown>` 占位对象(`{reason}`)非位置参。

**未解**：这批日志无渲染崩溃**原始堆栈**,只有崩溃后次生 send 错误,故"为何崩溃"(长会话 OOM 嫌疑)无法确证;修复后崩溃会显式记 `reason`,下次可判 OOM。附带发现 perforce 扩展 `refreshReconcilePaths` 反复 `spawn ENAMETOOLONG`(命令行过长)是独立扩展宿主问题,未处理。
