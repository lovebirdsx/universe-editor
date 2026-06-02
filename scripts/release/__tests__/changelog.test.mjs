/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for changelog.mjs commit parsing / grouping. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommit, buildGroups } from '../changelog.mjs'

test('parseCommit includes default user-facing types', () => {
  assert.deepEqual(parseCommit('feat: add remote workspace'), {
    type: 'feat',
    group: 'feat',
    breaking: false,
    summary: 'add remote workspace',
  })
  assert.equal(parseCommit('fix(send): stop spinner overlap')?.group, 'fix')
  assert.equal(parseCommit('perf(search): cut latency')?.group, 'perf')
  assert.equal(parseCommit('security: patch path traversal')?.group, 'security')
})

test('parseCommit drops excluded types unless breaking', () => {
  assert.equal(parseCommit('docs: tweak readme'), null)
  assert.equal(parseCommit('chore(deps): bump'), null)
  assert.deepEqual(parseCommit('refactor(core)!: drop legacy api'), {
    type: 'refactor',
    group: 'other',
    breaking: true,
    summary: 'drop legacy api',
  })
})

test('parseCommit ignores non-conventional subjects', () => {
  assert.equal(parseCommit('修复SendButton转圈动画的bug'), null)
  assert.equal(parseCommit('发布0.1.1'), null)
  assert.equal(parseCommit('feat:'), null)
})

test('buildGroups orders groups and aggregates items', () => {
  const groups = buildGroups([
    'fix: b',
    'feat: a1',
    'chore: skip',
    'feat: a2',
    'refactor!: r',
  ])
  assert.deepEqual(groups, [
    { type: 'feat', title: '新功能', items: ['a1', 'a2'] },
    { type: 'fix', title: 'Bug 修复', items: ['b'] },
    { type: 'other', title: '其他变更', items: ['r'] },
  ])
})
