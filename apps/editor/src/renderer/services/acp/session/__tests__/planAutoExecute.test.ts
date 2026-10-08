/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Truth table for the plan-review auto-execute contract: both forks' option
 *  shapes, the fail-closed edges, and the shared plan-mode / feedback predicates.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  isPlanModeConfigOptions,
  planApproveOptionIds,
  selectPlanAutoExecuteOptionId,
  supportsPlanReviewFeedback,
} from '../planAutoExecute.js'

const CLAUDE_OPTIONS = [
  { optionId: 'exit-plan-clear-auto', kind: 'allow_always' },
  { optionId: 'exit-plan-auto', kind: 'allow_always' },
  { optionId: 'exit-plan-bypass', kind: 'allow_always' },
  { optionId: 'exit-plan-accept-edits', kind: 'allow_always' },
  { optionId: 'exit-plan-default', kind: 'allow_once' },
  { optionId: 'reject', kind: 'reject_once' },
]

const CODEX_OPTIONS = [
  { optionId: 'implement_plan', kind: 'allow_once' },
  { optionId: 'revise_plan', kind: 'reject_once' },
]

const MODES = ['bypassPermissions', 'auto', 'acceptEdits', 'default'] as const

function configOption(category: string, currentValue: string): SessionConfigOption {
  return { id: category, name: category, category, currentValue } as unknown as SessionConfigOption
}

describe('planApproveOptionIds', () => {
  it.each([
    ['bypassPermissions', 'exit-plan-bypass'],
    ['auto', 'exit-plan-auto'],
    ['acceptEdits', 'exit-plan-accept-edits'],
    ['default', 'exit-plan-default'],
  ])('%s 档位保留上下文的 Claude 选项优先，codex 的 implement_plan 兜底', (mode, claudeId) => {
    expect(planApproveOptionIds(mode)).toEqual([claudeId, 'implement_plan'])
  })

  it.each(['off', 'typo'])('%s 不是可识别的档位', (mode) => {
    expect(planApproveOptionIds(mode)).toEqual([])
  })
})

describe('selectPlanAutoExecuteOptionId', () => {
  it.each([
    ['bypassPermissions', 'exit-plan-bypass'],
    ['auto', 'exit-plan-auto'],
    ['acceptEdits', 'exit-plan-accept-edits'],
    ['default', 'exit-plan-default'],
  ])('Claude 计划卡按 %s 选 %s', (mode, expected) => {
    expect(selectPlanAutoExecuteOptionId(CLAUDE_OPTIONS, mode)).toBe(expected)
  })

  it.each(MODES)('codex 计划卡按 %s 选 implement_plan', (mode) => {
    expect(selectPlanAutoExecuteOptionId(CODEX_OPTIONS, mode)).toBe('implement_plan')
  })

  it('两套选项同时存在时 Claude 档位优先', () => {
    expect(selectPlanAutoExecuteOptionId([...CLAUDE_OPTIONS, ...CODEX_OPTIONS], 'auto')).toBe(
      'exit-plan-auto',
    )
  })

  it('只有 revise_plan 时返回 undefined（绝不代选拒绝项）', () => {
    expect(selectPlanAutoExecuteOptionId([CODEX_OPTIONS[1]!], 'bypassPermissions')).toBeUndefined()
  })

  it('目标 id 的 kind 不是允许类时返回 undefined', () => {
    expect(
      selectPlanAutoExecuteOptionId(
        [{ optionId: 'implement_plan', kind: 'reject_once' }, CODEX_OPTIONS[1]!],
        'bypassPermissions',
      ),
    ).toBeUndefined()
  })

  it('kind 缺失时返回 undefined', () => {
    expect(
      selectPlanAutoExecuteOptionId([{ optionId: 'implement_plan' }], 'bypassPermissions'),
    ).toBeUndefined()
  })

  it('只提供清上下文变体时不自动执行', () => {
    expect(selectPlanAutoExecuteOptionId([CLAUDE_OPTIONS[0]!], 'auto')).toBeUndefined()
  })

  it.each(['off', 'typo'])('%s 档位不选任何选项', (mode) => {
    expect(selectPlanAutoExecuteOptionId(CLAUDE_OPTIONS, mode)).toBeUndefined()
    expect(selectPlanAutoExecuteOptionId(CODEX_OPTIONS, mode)).toBeUndefined()
  })
})

describe('isPlanModeConfigOptions', () => {
  it('Claude 的 mode=plan 是计划模式', () => {
    expect(isPlanModeConfigOptions([configOption('mode', 'plan')])).toBe(true)
  })

  it('codex 的 collaboration_mode=plan 是计划模式', () => {
    expect(isPlanModeConfigOptions([configOption('collaboration_mode', 'plan')])).toBe(true)
  })

  it.each([
    ['mode', 'default'],
    ['collaboration_mode', 'default'],
    ['model', 'plan'],
  ])('%s=%s 不是计划模式', (category, value) => {
    expect(isPlanModeConfigOptions([configOption(category, value)])).toBe(false)
  })

  it('没有任何配置项时不是计划模式', () => {
    expect(isPlanModeConfigOptions([])).toBe(false)
  })
})

describe('supportsPlanReviewFeedback', () => {
  it('Claude 计划卡支持意见回传', () => {
    expect(supportsPlanReviewFeedback(CLAUDE_OPTIONS)).toBe(true)
  })

  it('codex 计划卡不支持意见回传', () => {
    expect(supportsPlanReviewFeedback(CODEX_OPTIONS)).toBe(false)
  })

  it('空选项列表按支持处理（普通工具卡）', () => {
    expect(supportsPlanReviewFeedback([])).toBe(true)
  })
})
