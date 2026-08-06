---
name: textmate-grammar-only-language-plaintext-fallback
description: TextMate 语法贡献的语言若不在 monaco basic-languages 里，createModel 会静默回退 plaintext 导致无高亮；TextMateService.initialize 已补 register
metadata: 
  node_type: memory
  type: project
  originSessionId: b3766455-1d5a-43a4-a27f-bd700df5eda7
---

症状：状态栏显示语言类型正确（resourceLanguage 映射生效），但文件内容零高亮。根因：monaco `createModel(text, 'toml')` → `LanguageService._createAndGetLanguageIdentifier` 对未注册语言 id **静默回退 plaintext**，TextMate 工厂（按语言 id 绑定）永远不触发。状态栏显示的是 `languageForResource` 结果而非 model 真实语言，造成"类型对、无高亮"的假象。

**Why:** 所有 basic-languages 覆盖的语言天然注册了 id，问题只在"纯 TextMate 语法语言"（toml、dockercompose、cuda-cpp）上暴露。

**How to apply:** 修复在 `TextMateService.initialize`（`apps/editor/src/renderer/services/textmate/textMateService.ts`）：对工厂绑定的未知语言 id 补 `monaco.languages.register({id})`，已打开 model 经 `LanguageSelection` 重评估自愈。新增 TextMate 语言只需 grammar + resourceLanguage 两处，不要再手注册。回归测试 `__tests__/textMateService.test.ts`。排查高亮问题先确认 model 真实语言（不是状态栏），可用日志 `(lang, N lines)` 或探针。
