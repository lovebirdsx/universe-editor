/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help copy (markdown) shown by the "?" button on each AI settings category.
 *  Wrapped in localize so the strings stay translatable; the markdown is
 *  rendered by the shared MarkdownView.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'

export function aiModelsHelpText(): string {
  return localize(
    'aiSettings.help.models',
    [
      '## 模型配置',
      '',
      '在这里管理 AI 服务的 **Provider Group**。每个 group 是一组配置单位，包含：',
      '',
      '- **Base URL**：留空使用 provider 默认地址；指向任意 OpenAI 兼容端点（LM Studio / vLLM / DeepSeek 等）即可复用 `openai` provider。',
      '- **API Key**：仅加密存储于本机，**绝不**写入 `aiSettings.json`。',
      '- **Models**：端点枚举出的模型与你手写声明的模型合并展示，手写优先。',
      '',
      '部分模型可在 **Configure** 中调整参数（如 temperature）。',
      '需要直接编辑原始配置时，点右上角 **Open aiSettings.json**。',
    ].join('\n'),
  )
}

export function aiFeatureModelsHelpText(): string {
  return localize(
    'aiSettings.help.features',
    [
      '## 功能模型',
      '',
      '为不同 AI 功能分别指定使用的模型，互不影响：',
      '',
      '- **对话（Chat）**：AGENTS 会话与对话补全使用的主模型。',
      '- **内联补全**：编辑器幽灵文本补全（可选更小更快的模型）。',
      '- **Commit 信息**：生成 Git 提交信息使用的模型。',
      '',
      '点击任意一行会弹出模型选择器，选中后即时生效——与状态栏的模型选择体验一致。',
    ].join('\n'),
  )
}
