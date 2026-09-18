/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree.callbackRetention — 存活的树不得钉住自己做过的每一次渲染。
 *
 *  sizeAt（依赖 structureVersion）与 makeClickHandler（依赖 model / onActivate）交替换身份，同一渲染
 *  Context 保存着上一次 useCallback 返回的旧函数——当前帧沿闭包链回指历史，视图每更新一版就钉住一代。
 *  这里问真实 V8 回收而非回调身份；机制与堆快照证据见 docs/development/memory-pressure.md。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import vm from 'node:vm'
import v8 from 'node:v8'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
const ROWS = 24
/** 代数足够多：逐代泄漏会远大于常数项。 */
const GENERATIONS = 40
/** 当前 fiber + finished-work fiber 及其 props：常数，不随代数增长。 */
const RETAINED_BOUND = 4

interface Payload {
  generation: number
  body: string
}

/**
 * `--expose-gc` 不进本包的 vitest pool 配置（那会给所有无关用例都挂上 V8 开关），改用官方的
 * 测试逃生口：设完标志从一次性 vm 上下文里取 `gc`。取不到必须 fail loud 而不是 skip——
 * 静默不再运行的回收断言比没有更糟。
 */
function acquireGc(): () => void {
  const fromGlobal = (globalThis as { gc?: () => void }).gc
  if (typeof fromGlobal === 'function') return fromGlobal
  try {
    v8.setFlagsFromString('--expose-gc')
    const fromContext: unknown = vm.runInNewContext('gc')
    if (typeof fromContext === 'function') return fromContext as () => void
  } catch {
    // 落到下面那处唯一的显式失败
  }
  throw new Error('拿不到 GC：请带 --expose-gc 运行，或 v8.setFlagsFromString 逃生口必须继续可用')
}

/**
 * 完整回收 + 一个任务边界：WeakRef 的目标要活到读它的那个 job 结束，
 * 所以读取必须落在回收之后的新任务里。
 */
async function drain(gc: () => void): Promise<void> {
  for (let i = 0; i < 4; i++) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const aliveCount = (refs: readonly WeakRef<Payload>[]): number =>
  refs.filter((ref) => ref.deref() !== undefined).length

function makeModel(count: number): TreeModel<Node> {
  const roots: Node[] = Array.from({ length: count }, (_, i) => ({ id: `r${i}` }))
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

afterEach(() => cleanup())

describe('Tree — superseded renders are collectable', () => {
  it('does not retain one render frame per parent render / structure change pair', async () => {
    const gc = acquireGc()
    const model = makeModel(ROWS)
    const payloads: WeakRef<Payload>[] = []
    const setter: { current: ((generation: number) => void) | null } = { current: null }

    // 每代现造 payload，只被该代的内联 props 闭包捕获；harness 自己不留强引用，
    // 于是存活的 payload 就意味着树里还有东西指向它。
    function View() {
      const [generation, setGeneration] = useState(0)
      setter.current = setGeneration
      const payload: Payload = { generation, body: `outline-${generation}`.repeat(8) }
      payloads.push(new WeakRef(payload))
      return (
        <Tree<Node>
          model={model}
          rowHeight={ROW_HEIGHT}
          onActivate={(node) => {
            void `${payload.body}:${node.id}`
          }}
          renderRow={(ctx) => (
            <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
              {payload.body.slice(0, 4)}
              {ctx.node.id}
            </div>
          )}
        />
      )
    }

    render(<View />)
    const bump = setter.current
    if (!bump) throw new Error('视图没有渲染')
    expect(payloads).toHaveLength(1)

    // 交替且不批处理的两次提交：父组件带新的内联 onActivate 重渲染（makeClickHandler 的旧依赖），
    // 随后 model.refresh 让树自己重渲染（sizeAt 的旧依赖）。并成一次提交会同时换身份，掩盖交替失效。
    for (let generation = 1; generation <= GENERATIONS; generation++) {
      await act(async () => {
        bump(generation)
      })
      await act(async () => {
        model.refresh()
      })
    }

    const control = (() => new WeakRef<Payload>({ generation: -1, body: 'control' }))()
    await drain(gc)
    // 控制对象（只剩 WeakRef）必须被回收：它仍存活只说明这一轮未能证明不可达对象确实可回收，
    // 存活数随之不可解释——报错，别当成泄漏，也别据此说 GC 没跑。
    expect(control.deref()).toBeUndefined()

    const alive = aliveCount(payloads)
    // 最新一代按定义活着；连它都死了，说明探针什么也没测到。
    expect(payloads[payloads.length - 1]?.deref()).toBeDefined()
    expect(alive).toBeLessThanOrEqual(RETAINED_BOUND)

    model.dispose()
  })

  it('reports payloads that are still held, so a clean result is meaningful', async () => {
    const gc = acquireGc()
    const held: Payload[] = []
    const refs: WeakRef<Payload>[] = []
    for (let generation = 0; generation < 10; generation++) {
      const payload: Payload = { generation, body: 'held' }
      held.push(payload)
      refs.push(new WeakRef(payload))
    }

    await drain(gc)

    expect(aliveCount(refs)).toBe(held.length)
  })
})
