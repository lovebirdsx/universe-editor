---
name: config-layer-toggle-order-update-fire-semantics
description: 配置层 toggle 持久化必须先删工作区覆盖再写 User 层；ConfigurationService.update 按「写前 effective≠写入值」fire 而非写后 effective
metadata:
  type: project
---

给「配置化的 toggle」做全局持久化（如 inline completion 开关）：写 `ConfigurationTarget.User` + 清 `ConfigurationTarget.Project` 覆盖时，**顺序必须先删 Project 再写 User**。

**Why:** `ConfigurationService.update`（packages/platform/src/configuration/configurationService.ts）的 fire 判断是 `oldValue !== value`——`oldValue` 是**写前 effective 值**、`value` 是写入值，不是「写前 vs 写后 effective」。若先写 User 再删 Project，被工作区覆盖遮罩期间 update(User) 仍会 fire，订阅处理器读到遮罩中的旧值把内存状态**回弹**一次（订阅者可见假翻转）。先删覆盖再写全局则所有场景对外恰 fire 一次。已有单测守护（InlineCompletionService.test.ts 的 `enabled persistence` describe）与先例（editorActions.ts minimap toggle 只写 User 不删 Project——它没做覆盖清理，改它时要留意同样问题）。

**How to apply:** 任何「toggle 写全局配置 + 清工作区覆盖」的模式照抄 `InlineCompletionService.setEnabled`（apps/editor/src/renderer/services/ai/InlineCompletionService.ts）：`_applyEnabled` 内存先翻转 + 同值守卫吞配置事件回音，再 `update(key, undefined, Project)` → `update(key, value, User)`。相关：[[editor-input-identity-isolation]]。

**附 e2e 坑:** 冷启动后立即 toggle 会撞上 `UserSettingsSync.initialize` 的 hydration 竞态（其配置事件订阅注册在 initialize 末尾，早于该点的写盘丢失且无补救）——e2e 探针 `whenUserSettingsInitialized`（暴露 `IUserSettingsSyncService.whenInitialized`）就是为此而生的门控。
