/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { HistoryService } from '../HistoryService.js'

function entry(path: string, line?: number, col?: number) {
  return {
    resource: URI.file(path),
    ...(line !== undefined && {
      selection: {
        startLine: line,
        startColumn: col ?? 1,
        endLine: line,
        endColumn: col ?? 1,
      },
    }),
  }
}

describe('HistoryService', () => {
  it('canGoBack reflects depth (>=2 entries required)', () => {
    const h = new HistoryService()
    expect(h.canGoBack()).toBe(false)
    h.record(entry('/a.ts'))
    expect(h.canGoBack()).toBe(false)
    h.record(entry('/b.ts'))
    expect(h.canGoBack()).toBe(true)
  })

  it('records distinct files into back stack', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    expect(h.getBackStack().length).toBe(3)
    expect(h.getBackStack().map((e) => e.resource.fsPath)).toEqual([
      URI.file('/a.ts').fsPath,
      URI.file('/b.ts').fsPath,
      URI.file('/c.ts').fsPath,
    ])
  })

  it('replaces top in place when same file + same line (latest column wins)', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts', 10, 1))
    h.record(entry('/a.ts', 10, 5))
    expect(h.getBackStack().length).toBe(1)
    expect(h.getBackStack()[0]?.selection?.startColumn).toBe(5)
  })

  it('replaces top when previous has no selection but new entry does', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/a.ts', 5))
    expect(h.getBackStack().length).toBe(1)
    expect(h.getBackStack()[0]?.selection?.startLine).toBe(5)
  })

  it('pushes new entry when same file but different line', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts', 10))
    h.record(entry('/a.ts', 50))
    expect(h.getBackStack().length).toBe(2)
  })

  it('caps back stack at MAX_DEPTH=50', () => {
    const h = new HistoryService()
    for (let i = 0; i < 60; i++) h.record(entry(`/f${i}.ts`))
    expect(h.getBackStack().length).toBe(50)
    expect(h.getBackStack()[0]?.resource.fsPath).toBe(URI.file('/f10.ts').fsPath)
  })

  it('goBack returns previous entry and pushes current to forward stack', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    const target = h.goBack()
    expect(target?.resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    expect(h.getBackStack().length).toBe(2)
    expect(h.getForwardStack().length).toBe(1)
    expect(h.canGoForward()).toBe(true)
  })

  it('goBack returns undefined when fewer than 2 entries', () => {
    const h = new HistoryService()
    expect(h.goBack()).toBeUndefined()
    h.record(entry('/a.ts'))
    expect(h.goBack()).toBeUndefined()
  })

  it('goForward returns popped entry and pushes to back', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    const fwd = h.goForward()
    expect(fwd?.resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    expect(h.getForwardStack().length).toBe(0)
    expect(h.canGoForward()).toBe(false)
  })

  it('goForward returns undefined when forward stack empty', () => {
    const h = new HistoryService()
    expect(h.goForward()).toBeUndefined()
  })

  it('record after goBack drops the forward stack (real navigation, not the synthetic one)', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    h.goBack()
    expect(h.getForwardStack().length).toBe(1)
    // First record after goBack is the synthetic re-open of the target — suppressed.
    h.record(entry('/b.ts'))
    expect(h.getForwardStack().length).toBe(1)
    // Second record is a real user navigation — drops the forward stack.
    h.record(entry('/d.ts'))
    expect(h.getForwardStack().length).toBe(0)
  })

  it('suppresses the next record after goBack (caller-initiated navigation)', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    const target = h.goBack()
    // Caller re-opens target; cursor change would record it again.
    h.record({ resource: target!.resource })
    // The suppression consumed exactly one record; stack length stays at 2.
    expect(h.getBackStack().length).toBe(2)
  })

  it('suppresses the next record after goForward', () => {
    const h = new HistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    const fwd = h.goForward()
    h.record({ resource: fwd!.resource })
    expect(h.getBackStack().length).toBe(2)
    expect(h.getForwardStack().length).toBe(0)
  })

  it('fires onDidChange on record, goBack, goForward, clear', () => {
    const h = new HistoryService()
    let count = 0
    h.onDidChange(() => count++)
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    expect(count).toBe(2)
    h.goBack()
    expect(count).toBe(3)
    h.goForward()
    expect(count).toBe(4)
    h.clear()
    expect(count).toBe(5)
  })

  it('clear empties both stacks and is a no-op when already empty', () => {
    const h = new HistoryService()
    let count = 0
    h.onDidChange(() => count++)
    h.clear()
    expect(count).toBe(0)
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    h.clear()
    expect(h.getBackStack().length).toBe(0)
    expect(h.getForwardStack().length).toBe(0)
  })

  it('revives plain UriComponents in record()', () => {
    const h = new HistoryService()
    const components = URI.file('/x.ts').toJSON()
    // Cast away type: simulates a non-URI-instance payload (IPC boundary).
    h.record({ resource: components as unknown as URI })
    expect(h.getBackStack()[0]?.resource).toBeInstanceOf(URI)
  })
})
