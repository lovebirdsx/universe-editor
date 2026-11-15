/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ci-failures.mjs 测试：选择规则（只认最新一条已完成 run；cancelled 带失败 job/step 也算失败）、
 *  repo 解析、poll item 形状、gh 失败容错与 CLI 参数。gh 用注入的 runner 模拟，不访问网络。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPollItem,
  collectFailures,
  collectRunFailureDetails,
  fetchRunFailures,
  main,
  parseArgs,
  parseRepoFromRemote,
  selectFailures,
  selectLatestCompletedRun,
} from '../ci-failures.mjs'

function run(overrides = {}) {
  return {
    databaseId: 100,
    attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    headSha: 'a'.repeat(40),
    displayTitle: 'fix: something',
    url: 'https://github.com/example/universe-editor/actions/runs/100',
    createdAt: '2026-01-01T00:00:00Z',
    event: 'push',
    ...overrides,
  }
}

function fakeGh(responses) {
  const calls = []
  const runGh = (args) => {
    calls.push(args)
    for (const [match, response] of responses) {
      if (match(args)) {
        if (response instanceof Error) throw response
        return typeof response === 'string' ? response : JSON.stringify(response)
      }
    }
    throw new Error(`未匹配的 gh 调用: ${args.join(' ')}`)
  }
  return { runGh, calls }
}

test('parseRepoFromRemote: 常见 remote 形态', () => {
  assert.equal(
    parseRepoFromRemote('https://github.com/example/universe-editor.git'),
    'example/universe-editor',
  )
  assert.equal(
    parseRepoFromRemote('https://github.com/example/universe-editor'),
    'example/universe-editor',
  )
  assert.equal(
    parseRepoFromRemote('git@github.com:example/universe-editor.git'),
    'example/universe-editor',
  )
  assert.equal(
    parseRepoFromRemote('ssh://git@github.com/example/universe-editor.git'),
    'example/universe-editor',
  )
  assert.equal(parseRepoFromRemote('example/universe-editor'), 'example/universe-editor')
  assert.throws(() => parseRepoFromRemote('not a remote'), /无法从 origin 解析/)
})

test('selectFailures: 最新 run 还在跑（含 rerun 中）时不回落到更早的失败', () => {
  assert.deepEqual(
    selectFailures([
      run({ databaseId: 100, createdAt: '2026-01-01T00:00:00Z' }),
      run({
        databaseId: 101,
        createdAt: '2026-01-02T00:00:00Z',
        status: 'in_progress',
        conclusion: null,
      }),
      run({ databaseId: 99, createdAt: '2025-12-31T00:00:00Z', conclusion: 'success' }),
    ]),
    [],
  )
})

test('selectFailures: 最新已完成 run 不是 failure 时不输出', () => {
  for (const conclusion of ['success', 'cancelled', 'skipped', 'neutral']) {
    assert.deepEqual(
      selectFailures([
        run({ databaseId: 100, createdAt: '2026-01-01T00:00:00Z' }),
        run({ databaseId: 101, createdAt: '2026-01-02T00:00:00Z', conclusion }),
      ]),
      [],
      conclusion,
    )
  }
})

test('selectFailures: 多条失败按 createdAt 取最新，输入顺序无关', () => {
  const failures = selectFailures([
    run({ databaseId: 200, createdAt: '2026-01-02T00:00:00Z' }),
    run({ databaseId: 300, createdAt: '2026-01-03T00:00:00Z' }),
    run({ databaseId: 100, createdAt: '2026-01-01T00:00:00Z' }),
  ])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].runId, 300)
})

test('selectFailures: 只有未完成的 run 时不输出', () => {
  assert.deepEqual(
    selectFailures([
      run({ status: 'queued', conclusion: null }),
      run({ status: 'in_progress', conclusion: null }),
    ]),
    [],
  )
})

test('selectLatestCompletedRun: 最新 run 未完成时不回落到更早的 run', () => {
  assert.equal(
    selectLatestCompletedRun([
      run({ databaseId: 100, createdAt: '2026-01-01T00:00:00Z' }),
      run({
        databaseId: 101,
        createdAt: '2026-01-02T00:00:00Z',
        status: 'in_progress',
        conclusion: null,
      }),
    ]),
    undefined,
  )
})

test('selectLatestCompletedRun: 最新 completed 的 cancelled run 也会返回', () => {
  const latest = selectLatestCompletedRun([run({ conclusion: 'cancelled' })])
  assert.equal(latest?.conclusion, 'cancelled')
})

test('buildPollItem: key 用 <runId>:<attempt>，rerun 后是新 key', () => {
  const first = buildPollItem({
    runId: 42,
    attempt: 1,
    headSha: 'deadbeef',
    title: 'fix: x',
    url: 'https://github.com/example/repo/actions/runs/42',
    createdAt: '2026-01-01T00:00:00Z',
    event: 'push',
  })
  assert.deepEqual(first, {
    id: '42:1',
    runId: 42,
    attempt: 1,
    headSha: 'deadbeef',
    title: 'fix: x',
    url: 'https://github.com/example/repo/actions/runs/42',
    createdAt: '2026-01-01T00:00:00Z',
    event: 'push',
  })
  assert.equal(buildPollItem({ ...first, runId: 42, attempt: 2 }).id, '42:2')
})

test('fetchRunFailures: 收集 failure job 与失败步骤', () => {
  const { runGh } = fakeGh([
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      {
        jobs: [
          { name: 'Fast Lint / Guards', conclusion: 'failure' },
          { name: 'Typecheck / Test / Build', conclusion: 'success' },
          { name: 'E2E (windows 1/4)', conclusion: 'failure' },
          { name: 'E2E (windows 1/4)', conclusion: 'failure' },
        ],
      },
    ],
  ])
  assert.deepEqual(fetchRunFailures({ repo: 'example/repo', runId: 1, runGh }), {
    hasFailure: true,
    details: {
      failedJobs: ['Fast Lint / Guards', 'E2E (windows 1/4)'],
      failedJobCount: 2,
    },
  })
})

test('collectRunFailureDetails: cancelled job 的失败步骤也算失败', () => {
  assert.deepEqual(
    collectRunFailureDetails([
      {
        name: 'Fast Lint / Guards',
        conclusion: 'cancelled',
        steps: [
          { name: 'Docs link check', conclusion: 'success' },
          { name: 'Knowledge link check', conclusion: 'failure' },
          { name: 'Cancel the run', conclusion: 'success' },
        ],
      },
      { name: 'CI Gate', conclusion: 'failure', steps: [] },
      {
        name: 'E2E',
        conclusion: 'cancelled',
        steps: [{ name: 'Install dependencies', conclusion: 'cancelled' }],
      },
    ]),
    {
      hasFailure: true,
      details: {
        failedJobs: ['Fast Lint / Guards', 'CI Gate'],
        failedJobCount: 2,
        failedSteps: ['Fast Lint / Guards: Knowledge link check'],
      },
    },
  )
})

test('collectRunFailureDetails: 纯 cancelled 的 run 不算失败', () => {
  assert.deepEqual(
    collectRunFailureDetails([
      {
        name: 'E2E',
        conclusion: 'cancelled',
        steps: [{ name: 'Build', conclusion: 'cancelled' }],
      },
    ]),
    { hasFailure: false, details: { failedJobs: [], failedJobCount: 0 } },
  )
})

test('collectRunFailureDetails: 只有 CI Gate 失败不算真实失败', () => {
  assert.deepEqual(
    collectRunFailureDetails([
      {
        name: 'CI Gate',
        conclusion: 'failure',
        steps: [{ name: 'Fail if any required job failed or was cancelled', conclusion: 'failure' }],
      },
    ]),
    {
      hasFailure: false,
      details: {
        failedJobs: ['CI Gate'],
        failedJobCount: 1,
        failedSteps: ['CI Gate: Fail if any required job failed or was cancelled'],
      },
    },
  )
})

test('collectFailures: 失败 run 附带失败 job 列表', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run()]],
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      { jobs: [{ name: 'Fast Lint / Guards', conclusion: 'failure' }] },
    ],
  ])
  const failures = collectFailures({ repo: 'example/repo', runGh })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].id, '100:1')
  assert.deepEqual(failures[0].failedJobs, ['Fast Lint / Guards'])
  assert.equal(failures[0].failedJobCount, 1)
})

test('collectFailures: job 拉取失败只省略字段，仍输出失败 run', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run()]],
    [(args) => args[0] === 'run' && args[1] === 'view', new Error('HTTP 403')],
  ])
  const warnings = []
  const failures = collectFailures({
    repo: 'example/repo',
    runGh,
    stderr: { write: (text) => warnings.push(text) },
  })
  assert.equal(failures.length, 1)
  assert.equal('failedJobs' in failures[0], false)
  assert.match(warnings.join(''), /无法获取失败 job 列表/)
})

test('collectFailures: cancelled run 带失败步骤时按失败输出', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run({ conclusion: 'cancelled' })]],
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      {
        jobs: [
          {
            name: 'Fast Lint / Guards',
            conclusion: 'cancelled',
            steps: [{ name: 'Knowledge link check', conclusion: 'failure' }],
          },
          { name: 'CI Gate', conclusion: 'failure', steps: [] },
        ],
      },
    ],
  ])
  const failures = collectFailures({ repo: 'example/repo', runGh })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].id, '100:1')
  assert.deepEqual(failures[0].failedJobs, ['Fast Lint / Guards', 'CI Gate'])
  assert.deepEqual(failures[0].failedSteps, ['Fast Lint / Guards: Knowledge link check'])
})

test('collectFailures: cancelled run 没有失败 job 时输出空数组', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run({ conclusion: 'cancelled' })]],
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      {
        jobs: [
          {
            name: 'E2E',
            conclusion: 'cancelled',
            steps: [{ name: 'Build', conclusion: 'cancelled' }],
          },
        ],
      },
    ],
  ])
  assert.deepEqual(collectFailures({ repo: 'example/repo', runGh }), [])
})

test('collectFailures: cancelled run 只有 CI Gate 失败时输出空数组', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run({ conclusion: 'cancelled' })]],
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      {
        jobs: [
          {
            name: 'CI Gate',
            conclusion: 'failure',
            steps: [
              { name: 'Fail if any required job failed or was cancelled', conclusion: 'failure' },
            ],
          },
        ],
      },
    ],
  ])
  assert.deepEqual(collectFailures({ repo: 'example/repo', runGh }), [])
})

test('collectFailures: cancelled run 拉取 job 失败时跳过', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run({ conclusion: 'cancelled' })]],
    [(args) => args[0] === 'run' && args[1] === 'view', new Error('HTTP 403')],
  ])
  const warnings = []
  assert.deepEqual(
    collectFailures({
      repo: 'example/repo',
      runGh,
      stderr: { write: (text) => warnings.push(text) },
    }),
    [],
  )
  assert.match(warnings.join(''), /取消的 run 按无需处理跳过/)
})

test('collectFailures: 最新 run 绿时输出空数组且不拉 job', () => {
  const { runGh, calls } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run({ conclusion: 'success' })]],
  ])
  assert.deepEqual(collectFailures({ repo: 'example/repo', runGh }), [])
  assert.equal(calls.length, 1)
})

test('parseArgs: 默认值与覆盖', () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(
    parseArgs([
      '--repo',
      'example/repo',
      '--workflow',
      'ci.yml',
      '--branch',
      'main',
      '--limit',
      '5',
    ]),
    { repo: 'example/repo', workflow: 'ci.yml', branch: 'main', limit: 5 },
  )
  assert.throws(() => parseArgs(['--limit', '0']), /1\.\.100/)
  assert.throws(() => parseArgs(['--limit', 'x']), /1\.\.100/)
  assert.throws(() => parseArgs(['--repo']), /需要/)
  assert.throws(() => parseArgs(['--unknown']), /未知参数/)
})

test('main: 输出 poll JSON 数组', () => {
  const { runGh } = fakeGh([
    [(args) => args[0] === 'run' && args[1] === 'list', [run()]],
    [
      (args) => args[0] === 'run' && args[1] === 'view',
      { jobs: [{ name: 'Fast Lint / Guards', conclusion: 'failure' }] },
    ],
  ])
  const originalWrite = process.stdout.write
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    main(['--repo', 'example/repo'], { runGh })
  } finally {
    process.stdout.write = originalWrite
  }
  const parsed = JSON.parse(chunks.join(''))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, '100:1')
  assert.deepEqual(parsed[0].failedJobs, ['Fast Lint / Guards'])
})
