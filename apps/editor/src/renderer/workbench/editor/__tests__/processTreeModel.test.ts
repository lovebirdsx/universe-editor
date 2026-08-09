/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IProcessItem } from '../../../../shared/ipc/processMonitorService.js'
import { flattenProcessTree } from '../processTreeModel.js'

function proc(pid: number, children?: IProcessItem[]): IProcessItem {
  return {
    name: `p${pid}`,
    cmd: `p${pid} --flag`,
    pid,
    ppid: 0,
    load: 0,
    mem: 0,
    ...(children !== undefined ? { children } : {}),
  }
}

describe('flattenProcessTree', () => {
  it('flattens a fully expanded tree in pre-order with depths', () => {
    const root = proc(1, [proc(2, [proc(4), proc(5)]), proc(3)])
    const rows = flattenProcessTree(root, new Set())
    expect(rows.map((r) => r.item.pid)).toEqual([1, 2, 4, 5, 3])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1])
  })

  it('marks hasChildren only for nodes with children', () => {
    const root = proc(1, [proc(2), proc(3, [proc(4)])])
    const rows = flattenProcessTree(root, new Set())
    expect(rows.map((r) => [r.item.pid, r.hasChildren])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ])
  })

  it('prunes the subtree of a collapsed node but keeps the node itself', () => {
    const root = proc(1, [proc(2, [proc(4), proc(5)]), proc(3)])
    const rows = flattenProcessTree(root, new Set([2]))
    expect(rows.map((r) => r.item.pid)).toEqual([1, 2, 3])
    expect(rows[1]?.hasChildren).toBe(true)
  })

  it('collapsing the root yields only the root row', () => {
    const root = proc(1, [proc(2), proc(3)])
    const rows = flattenProcessTree(root, new Set([1]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.item.pid).toBe(1)
  })

  it('treats a missing children array as a leaf', () => {
    const rows = flattenProcessTree(proc(7), new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.hasChildren).toBe(false)
  })

  it('ignores collapsed pids that do not exist in the tree', () => {
    const root = proc(1, [proc(2)])
    const rows = flattenProcessTree(root, new Set([999]))
    expect(rows.map((r) => r.item.pid)).toEqual([1, 2])
  })
})
