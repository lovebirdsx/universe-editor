import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { patchCodeAction } from '../../../vendor/typescript-language-server/patch.mjs'

const anchor =
  '    const actions = await this.codeActionsManager.provideCodeActions(document, params.range, params.context, token);'

test('补丁幂等，重复应用不重复插入守卫', () => {
  const patched = patchCodeAction(anchor)
  assert.notEqual(patched, anchor)
  assert.equal(patchCodeAction(patched), patched)
})

test('上游锚点缺失或重复必须报错', () => {
  assert.throws(() => patchCodeAction('upstream changed'), /补丁锚点/)
  assert.throws(() => patchCodeAction(`${anchor}\n${anchor}`), /补丁锚点/)
})

test('已有不同版本补丁时要求重装，不重复插入版本变量', () => {
  const outdated = patchCodeAction(anchor).replace('const version =', 'const previousVersion =')
  assert.throws(() => patchCodeAction(outdated), /已有不同版本补丁/)
})

const cli = new URL(
  '../../../vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
  import.meta.url,
)

function harness() {
  const source = readFileSync(cli, 'utf8')
  const start = source.indexOf('  async codeAction(params, token) {')
  const end = source.indexOf('  async getRefactors(', start)
  assert.ok(start >= 0 && end > start, 'TSLS codeAction 锚点已变化')
  const handler = new Function(
    'Range',
    'CodeActionKind',
    'provideRefactors',
    `return ({${source.slice(start, end)}}).codeAction`,
  )({ toFileRangeRequestArgs: (_file, range) => range }, {}, (actions) => actions)
  const original = {
    uri: 'file:///workspace/error.ts',
    filepath: '/workspace/error.ts',
    version: 1,
  }
  let document = original
  let resume
  const waiting = new Promise((resolve) => {
    resume = resolve
  })
  let refactors = 0
  const logs = []
  const token = { isCancellationRequested: false }
  const request = handler.call(
    {
      logger: { log: (...args) => logs.push(args) },
      tsClient: { toOpenDocument: () => document },
      codeActionsManager: { provideCodeActions: () => waiting },
      getRefactors: async () => {
        refactors++
        return [{ title: '正常重构' }]
      },
    },
    { textDocument: { uri: original.uri }, range: {}, context: {} },
    token,
  )
  return {
    original,
    token,
    request,
    resume,
    setDocument: (doc) => {
      document = doc
    },
    refactors: () => refactors,
    logs,
  }
}

for (const reason of ['change', 'close', 'reopen', 'cancel']) {
  test(`TSLS 等待后 ${reason} 不得继续请求旧位置重构`, { skip: !existsSync(cli) }, async () => {
    const h = harness()
    if (reason === 'change') h.original.version++
    if (reason === 'close') h.setDocument(undefined)
    if (reason === 'reopen') h.setDocument({ ...h.original })
    if (reason === 'cancel') h.token.isCancellationRequested = true
    h.resume([{ title: '旧 quick fix' }])
    assert.deepEqual(await h.request, [])
    assert.equal(h.refactors(), 0)
    assert.equal(h.logs.length, 1)
    assert.equal(h.logs[0][0], 'Discarding stale codeAction')
  })
}

test('TSLS 未变化文档保留 quick fix 和 refactor', { skip: !existsSync(cli) }, async () => {
  const h = harness()
  h.resume([{ title: '正常 quick fix' }])
  assert.deepEqual(await h.request, [{ title: '正常 quick fix' }, { title: '正常重构' }])
  assert.equal(h.refactors(), 1)
})
