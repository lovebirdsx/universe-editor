import { describe, expect, it } from 'vitest'
import {
  ancestorPids,
  collectDescendants,
  containsMarker,
  parseProcessTable,
  planProcessSweep,
  type ProcessRow,
} from '../processSweep.js'

const FIXTURE = '/run/ue-tmp/ue-e2e-4242-zz/universe-editor-e2e-abcdef'
const RUN_ROOT = '/run/ue-tmp/ue-e2e-4242-zz'
const OTHER_FIXTURE = '/run/ue-tmp/ue-e2e-4242-zz/universe-editor-e2e-ghijkl'

function row(pid: number, ppid: number, args: string): ProcessRow {
  return { pid, ppid, args }
}

describe('parseProcessTable', () => {
  it('解析 pid/ppid/args 三列，args 允许为空或带方括号', () => {
    const stdout = [
      '      1       0 /sbin/init splash',
      '      2       0 [kthreadd]',
      '     55       1 /usr/lib/systemd/systemd-journald',
      '',
      '    not a ps line at all',
      '    106       1 ',
    ].join('\n')
    expect(parseProcessTable(stdout)).toEqual([
      row(1, 0, '/sbin/init splash'),
      row(2, 0, '[kthreadd]'),
      row(55, 1, '/usr/lib/systemd/systemd-journald'),
      row(106, 1, ''),
    ])
  })

  it('CRLF 与空输入都不抛', () => {
    expect(parseProcessTable('1 0 /sbin/init\r\n2 1 [kthreadd]\r\n')).toEqual([
      row(1, 0, '/sbin/init'),
      row(2, 1, '[kthreadd]'),
    ])
    expect(parseProcessTable('')).toEqual([])
  })

  it('保留带空格与换行的完整命令行，不截断', () => {
    const longArgs = `--user-data-dir=${FIXTURE} --type=gpu-process --lang=en-US --field-trial=${'x'.repeat(300)}`
    expect(parseProcessTable(`  42   1 ${longArgs}`)).toEqual([row(42, 1, longArgs)])
  })
})

describe('ancestorPids', () => {
  const table = [row(1, 0, 'init'), row(100, 1, 'a'), row(200, 100, 'b'), row(300, 200, 'c')]

  it('返回祖先链但不含自身与 init', () => {
    expect(ancestorPids(table, 300)).toEqual([200, 100])
    expect(ancestorPids(table, 100)).toEqual([])
  })

  it('pid 不在表里时返回空', () => {
    expect(ancestorPids(table, 999)).toEqual([])
  })

  it('ppid 成环时不死循环', () => {
    const cyclic = [row(400, 500, 'a'), row(500, 400, 'b')]
    expect(ancestorPids(cyclic, 400)).toEqual([500])
  })
})

describe('collectDescendants', () => {
  it('收全整棵子树（含根自身）', () => {
    const table = [row(100, 1, 'root'), row(101, 100, 'child'), row(102, 101, 'grandchild')]
    expect(collectDescendants(table, [100])).toEqual([100, 101, 102])
  })

  it('断链的子孙不是根的后代——这正是需要命令行签名匹配的原因', () => {
    // 100 是已死的 electron 主进程；它拉起的 daemon 与 helper 被 reparent 到 init，
    // ppid 图里再也走不回 100，只能靠命令行里的 userDataDir 找回。
    const table = [
      row(200, 1, `bootstrap.js serve --data-dir ${FIXTURE}/remote-direct/e2e-local`),
      row(201, 1, `electron --type=gpu-process --user-data-dir=${FIXTURE}`),
    ]
    expect(collectDescendants(table, [100])).toEqual([100])
  })

  it('多个根与重复根都去重', () => {
    const table = [row(10, 1, 'a'), row(11, 10, 'b'), row(20, 1, 'c')]
    expect(collectDescendants(table, [10, 10, 20])).toEqual([10, 11, 20])
  })

  it('空根集返回空', () => {
    expect(collectDescendants([row(1, 0, 'init')], [])).toEqual([])
  })
})

describe('containsMarker', () => {
  it('命中 --user-data-dir=<marker>（后跟空格、后跟结尾两种）', () => {
    expect(containsMarker(`--user-data-dir=${FIXTURE} --type=gpu-process`, FIXTURE)).toBe(true)
    expect(containsMarker(`--user-data-dir=${FIXTURE}`, FIXTURE)).toBe(true)
  })

  it('命中 --data-dir <marker>/remote-direct/... 形态的 daemon', () => {
    expect(
      containsMarker(
        `node bootstrap.js serve --data-dir ${FIXTURE}/remote-direct/e2e-local`,
        FIXTURE,
      ),
    ).toBe(true)
  })

  it('marker 作为位置参数出现时也命中', () => {
    expect(containsMarker(`${FIXTURE} --enable-e2e-probe`, FIXTURE)).toBe(true)
  })

  it('右边界：兄弟目录不能被子串命中', () => {
    expect(containsMarker(`--user-data-dir=${FIXTURE}XYZ`, FIXTURE)).toBe(false)
    // run 根之间也会互为前缀（ue-e2e-1-abc 与 ue-e2e-1-abcdef）。
    expect(containsMarker(`--user-data-dir=${RUN_ROOT}extra/x`, RUN_ROOT)).toBe(false)
  })

  it('左边界：更长路径的后缀不算命中', () => {
    expect(containsMarker('--user-data-dir=/home/u/run/ue-tmp/ue-e2e-4242-zz/x', RUN_ROOT)).toBe(
      false,
    )
  })

  it('空 marker 与空命令行都不命中', () => {
    expect(containsMarker(`--user-data-dir=${FIXTURE}`, '')).toBe(false)
    expect(containsMarker('', FIXTURE)).toBe(false)
  })
})

describe('planProcessSweep', () => {
  it('红线：绝不选中开发者自己的常驻 daemon', () => {
    // 常驻服务与 fixture daemon 的命令行同形（bootstrap.js serve --data-dir），
    // 靠 --data-dir 的值区分。按 marker 清扫必须只碰后者。
    const devDaemon = row(
      900,
      1,
      'node /home/dev/.universe-editor-server/0.1.0/bootstrap.js serve --data-dir /home/dev/.universe-editor-server/0.1.0',
    )
    const table = [
      devDaemon,
      row(100, 1, `electron out/main/index.js --user-data-dir=${FIXTURE} --enable-e2e-probe`),
      row(101, 100, `electron --type=gpu-process --user-data-dir=${FIXTURE}`),
      row(102, 100, `node bootstrap.js serve --data-dir ${FIXTURE}/remote-direct/e2e-local`),
    ]

    const plan = planProcessSweep(table, [FIXTURE])

    expect(plan.pids).toEqual([100, 101, 102])
    expect(plan.pids).not.toContain(devDaemon.pid)
  })

  it('另一个 fixture 的目录不被选中（含 -shared- 变体）', () => {
    const table = [
      row(100, 1, `electron --user-data-dir=${FIXTURE}`),
      row(200, 1, `electron --user-data-dir=${OTHER_FIXTURE}`),
      row(300, 1, `electron --user-data-dir=${RUN_ROOT}/universe-editor-e2e-shared-zzzzzz`),
    ]
    expect(planProcessSweep(table, [FIXTURE]).pids).toEqual([100])
  })

  it('run 根 marker 覆盖本趟全部 fixture，但不会漏到别人的运行', () => {
    const table = [
      row(100, 1, `electron --user-data-dir=${FIXTURE}`),
      row(200, 1, `electron --user-data-dir=${OTHER_FIXTURE}`),
      row(300, 1, `electron --user-data-dir=/run/ue-tmp/ue-e2e-9999-qq/universe-editor-e2e-abcdef`),
    ]
    expect(planProcessSweep(table, [RUN_ROOT]).pids).toEqual([100, 200])
  })

  it('自身与祖先只按 pid 排除，其子树仍在命中范围内', () => {
    const runner = row(500, 1, 'node playwright/lib/runner/index.js')
    const worker = row(600, 500, 'node playwright/lib/worker/workerMain.js')
    const siblingWorker = row(700, 500, 'node playwright/lib/worker/workerMain.js')
    const table = [
      row(1, 0, '/sbin/init'),
      runner,
      worker,
      siblingWorker,
      row(601, 600, `node bootstrap.js serve --data-dir ${FIXTURE}/remote-direct/e2e-local`),
      row(701, 700, `electron --user-data-dir=${FIXTURE}`),
    ]

    const plan = planProcessSweep(table, [FIXTURE], {
      excludePids: [600, ...ancestorPids(table, 600)],
    })

    // worker 与 runner 自身不杀；但共享 runner 祖先的兄弟 worker 的 app 仍然要被收走
    // ——若把祖先的子树也排除掉，这条会变空，清扫就整个失效。
    expect(plan.pids).toEqual([601, 701])
    expect(plan.pids).not.toContain(runner.pid)
  })

  it('excludeSubtrees 排除活体 app 的整棵子树，被 reparent 的 daemon 仍被收走', () => {
    const liveApp = row(800, 700, `electron --user-data-dir=${FIXTURE} --enable-e2e-probe`)
    const table = [
      liveApp,
      row(801, 800, `electron --type=gpu-process --user-data-dir=${FIXTURE}`),
      row(900, 1, `node bootstrap.js serve --data-dir ${FIXTURE}/remote-direct/e2e-local`),
    ]

    const plan = planProcessSweep(table, [FIXTURE], { excludeSubtrees: [liveApp.pid] })

    expect(plan.pids).toEqual([900])
  })

  it('空 marker 或空表返回空计划', () => {
    expect(planProcessSweep([row(100, 1, `--user-data-dir=${FIXTURE}`)], [])).toEqual({
      pids: [],
      rows: [],
    })
    expect(planProcessSweep([], [FIXTURE])).toEqual({ pids: [], rows: [] })
  })

  it('永不选中 pid <= 1', () => {
    expect(planProcessSweep([row(1, 0, `${FIXTURE}`), row(0, 0, `${FIXTURE}`)], [FIXTURE])).toEqual(
      { pids: [], rows: [] },
    )
  })
})
