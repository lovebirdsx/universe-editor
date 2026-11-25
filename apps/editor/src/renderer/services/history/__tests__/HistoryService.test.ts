/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  URI,
  UriIdentityService,
  type IHistoryEntry,
  type IHistoryStackEntry,
} from '@universe-editor/platform'
import { HistoryService } from '../HistoryService.js'

const makeHistoryService = () => new HistoryService(new UriIdentityService('linux'))

function backEditors(h: HistoryService): IHistoryEntry[] {
  return h.getBackStack().filter((e): e is IHistoryEntry => e.kind !== 'view')
}

function forwardEditors(h: HistoryService): IHistoryEntry[] {
  return h.getForwardStack().filter((e): e is IHistoryEntry => e.kind !== 'view')
}

function editorEntry(e: IHistoryStackEntry | undefined): IHistoryEntry {
  if (!e || e.kind === 'view') throw new Error('expected an editor history entry')
  return e
}

function topOf(list: readonly IHistoryStackEntry[]): IHistoryStackEntry | undefined {
  return list[list.length - 1]
}

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
    const h = makeHistoryService()
    expect(h.canGoBack()).toBe(false)
    h.record(entry('/a.ts'))
    expect(h.canGoBack()).toBe(false)
    h.record(entry('/b.ts'))
    expect(h.canGoBack()).toBe(true)
  })

  it('records distinct files into back stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    expect(backEditors(h).length).toBe(3)
    expect(backEditors(h).map((e) => e.resource.fsPath)).toEqual([
      URI.file('/a.ts').fsPath,
      URI.file('/b.ts').fsPath,
      URI.file('/c.ts').fsPath,
    ])
  })

  it('replaces top in place when same file + same line (latest column wins)', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 10, 1))
    h.record(entry('/a.ts', 10, 5))
    expect(backEditors(h).length).toBe(1)
    expect(backEditors(h)[0]?.selection?.startColumn).toBe(5)
  })

  it('replaces top when previous has no selection but new entry does', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/a.ts', 5))
    expect(backEditors(h).length).toBe(1)
    expect(backEditors(h)[0]?.selection?.startLine).toBe(5)
  })

  it('pushes new entry when same file but different line', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 10))
    h.record(entry('/a.ts', 50))
    expect(backEditors(h).length).toBe(2)
  })

  it('caps back stack at MAX_DEPTH=50', () => {
    const h = makeHistoryService()
    for (let i = 0; i < 60; i++) h.record(entry(`/f${i}.ts`))
    expect(backEditors(h).length).toBe(50)
    expect(backEditors(h)[0]?.resource.fsPath).toBe(URI.file('/f10.ts').fsPath)
  })

  it('goBack returns previous entry and pushes current to forward stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    const target = h.goBack()
    expect(editorEntry(target).resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    expect(backEditors(h).length).toBe(2)
    expect(forwardEditors(h).length).toBe(1)
    expect(h.canGoForward()).toBe(true)
  })

  it('goBack returns undefined when fewer than 2 entries', () => {
    const h = makeHistoryService()
    expect(h.goBack()).toBeUndefined()
    h.record(entry('/a.ts'))
    expect(h.goBack()).toBeUndefined()
  })

  it('goForward returns popped entry and pushes to back', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    const fwd = h.goForward()
    expect(editorEntry(fwd).resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    expect(forwardEditors(h).length).toBe(0)
    expect(h.canGoForward()).toBe(false)
  })

  it('goForward returns undefined when forward stack empty', () => {
    const h = makeHistoryService()
    expect(h.goForward()).toBeUndefined()
  })

  it('record after goBack drops the forward stack (real navigation, not the synthetic one)', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    h.goBack()
    expect(forwardEditors(h).length).toBe(1)
    // First record after goBack is the synthetic re-open of the target — suppressed.
    h.record(entry('/b.ts'))
    expect(forwardEditors(h).length).toBe(1)
    // Second record is a real user navigation — drops the forward stack.
    h.record(entry('/d.ts'))
    expect(forwardEditors(h).length).toBe(0)
  })

  it('suppresses the next record after goBack (caller-initiated navigation)', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    const target = h.goBack()
    // Caller re-opens target; cursor change would record it again.
    h.record({ resource: editorEntry(target).resource })
    // The suppression consumed exactly one record; stack length stays at 2.
    expect(backEditors(h).length).toBe(2)
  })

  it('suppresses the next record after goForward', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    const fwd = h.goForward()
    h.record({ resource: editorEntry(fwd).resource })
    expect(backEditors(h).length).toBe(2)
    expect(forwardEditors(h).length).toBe(0)
  })

  it('keeps the forward stack across multiple same-target records after goBack', () => {
    // Regression: a single goBack fires several records for the target — the
    // synchronous active-editor change AND the debounced cursor flush. All of
    // them must be swallowed; if any leaks through, record() clears forward and
    // GoForward (alt+right) silently breaks.
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    const target = h.goBack()
    expect(forwardEditors(h).length).toBe(1)
    // active-editor autorun re-opens the target
    h.record({ resource: editorEntry(target).resource })
    // ...then the trailing cursor flush lands with a concrete selection
    h.record(entry('/a.ts', 12, 3))
    expect(forwardEditors(h).length).toBe(1)
    expect(h.canGoForward()).toBe(true)
  })

  it('a record for a different resource inside the window closes suppression', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    h.goBack() // target /b.ts, forward = [c]
    h.record(entry('/d.ts')) // genuine navigation elsewhere — drops forward
    expect(forwardEditors(h).length).toBe(0)
    expect(backEditors(h).map((e) => e.resource.fsPath)).toEqual([
      URI.file('/a.ts').fsPath,
      URI.file('/b.ts').fsPath,
      URI.file('/d.ts').fsPath,
    ])
  })

  it('fires onDidChange on record, goBack, goForward, clear', () => {
    const h = makeHistoryService()
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
    const h = makeHistoryService()
    let count = 0
    h.onDidChange(() => count++)
    h.clear()
    expect(count).toBe(0)
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    h.clear()
    expect(backEditors(h).length).toBe(0)
    expect(forwardEditors(h).length).toBe(0)
  })

  it('revives plain UriComponents in record()', () => {
    const h = makeHistoryService()
    const components = URI.file('/x.ts').toJSON()
    // Cast away type: simulates a non-URI-instance payload (IPC boundary).
    h.record({ resource: components as unknown as URI })
    expect(backEditors(h)[0]?.resource).toBeInstanceOf(URI)
  })

  it('updateCurrent rewrites the selection of the matching entry in place', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1, 1))
    h.record(entry('/b.ts'))
    h.updateCurrent(URI.file('/a.ts'), {
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 3,
    })
    const a = backEditors(h).find((e) => e.resource.fsPath === URI.file('/a.ts').fsPath)
    expect(a?.selection?.startLine).toBe(2)
    expect(a?.selection?.startColumn).toBe(3)
    // Stack shape is untouched.
    expect(backEditors(h).length).toBe(2)
  })

  it('updateCurrent does not touch the forward stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.record(entry('/b.ts'))
    h.goBack() // forward = [b]
    h.updateCurrent(URI.file('/a.ts'), { startLine: 9, startColumn: 1, endLine: 9, endColumn: 1 })
    expect(forwardEditors(h).length).toBe(1)
    expect(h.canGoForward()).toBe(true)
  })

  it('updateCurrent is a no-op when the resource has no entry', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    let fired = 0
    h.onDidChange(() => fired++)
    h.updateCurrent(URI.file('/z.ts'), { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 })
    expect(fired).toBe(0)
  })

  it('updateCurrent matches a resource whose drive-letter case differs (win32 identity)', () => {
    const h = new HistoryService(new UriIdentityService('win32'))
    h.record({
      resource: URI.parse('file:///C:/dir/a.ts'),
      selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    })
    h.updateCurrent(URI.parse('file:///c:/dir/a.ts'), {
      startLine: 9,
      startColumn: 3,
      endLine: 9,
      endColumn: 3,
    })
    const top = backEditors(h)[0]
    expect(top?.selection?.startLine).toBe(9)
    expect(top?.selection?.startColumn).toBe(3)
    expect(backEditors(h).length).toBe(1)
  })

  it('suppresses late records for each navigation target independently (multi-resource window)', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.record(entry('/c.ts'))
    const b = h.goBack() // target /b.ts — forward [c]
    expect(editorEntry(b).resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    // Rapid second navigation inside the first window: /a.ts gets its own window.
    const a = h.goBack()
    expect(editorEntry(a).resource.fsPath).toBe(URI.file('/a.ts').fsPath)
    expect(forwardEditors(h).length).toBe(2)
    // A late record for the FIRST target still lands inside its window: swallowed.
    h.record(entry('/b.ts', 7, 1))
    expect(forwardEditors(h).length).toBe(2)
    // ...and so is one for the second target.
    h.record(entry('/a.ts', 3, 1))
    expect(forwardEditors(h).length).toBe(2)
    expect(backEditors(h).length).toBe(1)
  })

  it('settleNavigation extends the target suppression so the post-reveal flush is still swallowed', () => {
    vi.useFakeTimers()
    try {
      const h = makeHistoryService()
      h.record(entry('/a.ts'))
      h.record(entry('/b.ts'))
      h.goBack() // target /a.ts — suppressed until now + 1000
      expect(forwardEditors(h).length).toBe(1)
      vi.advanceTimersByTime(900)
      // The reveal completes just before the original window would lapse.
      h.settleNavigation(URI.file('/a.ts'))
      vi.advanceTimersByTime(300) // 1200 > 1000, still inside the settled window
      h.record(entry('/a.ts', 5, 1))
      expect(forwardEditors(h).length).toBe(1) // swallowed — forward survives
      vi.advanceTimersByTime(100) // 1300 > settled deadline (900 + 350)
      h.record(entry('/a.ts', 6, 1))
      expect(forwardEditors(h).length).toBe(0) // expired — recorded for real
    } finally {
      vi.useRealTimers()
    }
  })

  it('settleNavigation is a no-op for a resource that is not being suppressed', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    // Neither resource is suppressed (no goBack/goForward ran) — settle must
    // not create a window out of thin air.
    h.settleNavigation(URI.file('/z.ts'))
    h.settleNavigation(URI.file('/a.ts'))
    expect(backEditors(h).length).toBe(2)
  })

  it('fires onWillNavigate synchronously before goBack pops the stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    const depths: number[] = []
    h.onWillNavigate(() => depths.push(backEditors(h).length))
    h.goBack()
    expect(depths).toEqual([2]) // listener observed the pre-pop depth
  })

  it('fires onWillNavigate before the depth check, letting a listener flush a move that makes goBack valid', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    let fired = 0
    h.onWillNavigate(() => {
      fired++
      // The pending debounced move for /b.ts lands synchronously...
      if (backEditors(h).length === 1) h.record(entry('/b.ts'))
    })
    const target = h.goBack()
    expect(fired).toBe(1)
    expect(editorEntry(target).resource.fsPath).toBe(URI.file('/a.ts').fsPath)
    expect(forwardEditors(h).length).toBe(1)
  })

  it('fires onWillNavigate synchronously before goForward pops the forward stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts'))
    h.record(entry('/b.ts'))
    h.goBack()
    const forwardDepths: number[] = []
    h.onWillNavigate(() => forwardDepths.push(forwardEditors(h).length))
    h.goForward()
    expect(forwardDepths).toEqual([1])
  })

  it('collapse merges fields instead of wiping them', () => {
    const h = makeHistoryService()
    // A jump record with a selection...
    h.record(entry('/a.ts', 11, 5))
    // ...then an active-editor placeholder for the same file carrying no
    // selection: the collapse must keep the selection and add the typeId.
    h.record({ resource: URI.file('/a.ts'), typeId: 'fileEditor', serialized: 's' })
    expect(backEditors(h).length).toBe(1)
    expect(backEditors(h)[0]?.selection?.startLine).toBe(11)
    expect(backEditors(h)[0]?.typeId).toBe('fileEditor')

    // A later cursor record carries a selection but no typeId: latest
    // selection wins, typeId survives.
    h.record(entry('/a.ts', 11, 9))
    expect(backEditors(h).length).toBe(1)
    expect(backEditors(h)[0]?.selection?.startColumn).toBe(9)
    expect(backEditors(h)[0]?.typeId).toBe('fileEditor')
    expect(backEditors(h)[0]?.serialized).toBe('s')
  })
})

describe('HistoryService view entries', () => {
  it('recordView pushes the view and clears the forward stack', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.record(entry('/b.ts', 1))
    h.goBack() // forward = [b]
    expect(h.getForwardStack().length).toBe(1)
    h.recordView('workbench.view.explorer.tree')
    expect(topOf(h.getBackStack())).toMatchObject({
      kind: 'view',
      viewId: 'workbench.view.explorer.tree',
    })
    expect(h.getForwardStack().length).toBe(0)
  })

  it('recordView is a no-op when that view already is current, preserving the forward stack', () => {
    // Ctrl+I lands on the view; the focus event then re-records it. Clearing
    // the forward stack here would make a second Ctrl+I impossible.
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.recordView('explorer')
    h.record(entry('/b.ts', 1))
    h.goBack() // back = [a, V], forward = [b]
    expect(h.getForwardStack().length).toBe(1)
    let fired = 0
    h.onDidChange(() => fired++)
    h.recordView('explorer')
    expect(fired).toBe(0)
    expect(h.getForwardStack().length).toBe(1)
    expect(h.getBackStack().length).toBe(2)
  })

  it('recordView dedupes an older occurrence and folds the editors it separated', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 50))
    h.recordView('explorer')
    // Esc back to the editor at the same position pushes a third entry.
    h.record(entry('/a.ts', 50))
    expect(h.getBackStack().length).toBe(3)
    h.recordView('explorer')
    expect(h.getBackStack().length).toBe(2)
    expect(backEditors(h).length).toBe(1)
    expect(editorEntry(backEditors(h)[0]).selection?.startLine).toBe(50)
    expect(topOf(h.getBackStack())).toMatchObject({ kind: 'view', viewId: 'explorer' })
  })

  it('recordView does not fold adjacent editors sitting on different lines', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 50))
    h.recordView('explorer')
    h.record(entry('/a.ts', 80))
    h.recordView('explorer')
    expect(backEditors(h).map((e) => e.selection?.startLine)).toEqual([50, 80])
  })

  it('recordView keeps open suppression windows', () => {
    // The window left by the landing editor swallows its own late cursor flush
    // even though the view record arrived in between.
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.record(entry('/b.ts', 1))
    h.goBack() // target /a.ts suppressed
    h.recordView('explorer')
    h.record(entry('/a.ts', 5))
    expect(backEditors(h).map((e) => e.selection?.startLine)).toEqual([1])
    expect(h.getBackStack().length).toBe(2)
  })

  it('removeViewEntries drops views from the back stack and folds adjacent editors', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 50))
    h.recordView('explorer')
    h.record(entry('/a.ts', 50))
    h.removeViewEntries()
    expect(h.getBackStack().length).toBe(1)
    expect(editorEntry(h.getBackStack()[0]).selection?.startLine).toBe(50)
  })

  it('removeViewEntries drops views from the forward stack too', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.record(entry('/b.ts', 1))
    h.recordView('explorer')
    h.goBack() // forward = [view]
    expect(h.getForwardStack().length).toBe(1)
    h.removeViewEntries()
    expect(h.getForwardStack().length).toBe(0)
    expect(h.getBackStack().length).toBe(2)
  })

  it('removeViewEntries is a no-op without views', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.record(entry('/b.ts', 1))
    let fired = 0
    h.onDidChange(() => fired++)
    h.removeViewEntries()
    expect(fired).toBe(0)
    expect(h.getBackStack().length).toBe(2)
  })

  it('goBack with a count fires onWillNavigate once and pushes crossed entries in order', () => {
    const h = makeHistoryService()
    for (const name of ['a', 'b', 'c', 'd']) h.record(entry(`/${name}.ts`, 1))
    let fired = 0
    h.onWillNavigate(() => fired++)
    const target = h.goBack({ count: 2 })
    expect(fired).toBe(1)
    expect(editorEntry(target).resource.fsPath).toBe(URI.file('/b.ts').fsPath)
    expect(h.getBackStack().length).toBe(2)
    // Forward is oldest-first: the entry just above the target is the nearest one.
    expect(forwardEditors(h).map((e) => e.resource.fsPath)).toEqual([
      URI.file('/d.ts').fsPath,
      URI.file('/c.ts').fsPath,
    ])
  })

  it('goBack skips stale entries without consuming the count', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.recordView('gone')
    h.record(entry('/b.ts', 1))
    h.record(entry('/c.ts', 1))
    const target = h.goBack({ count: 2, isStale: (e) => e.kind === 'view' })
    expect(editorEntry(target).resource.fsPath).toBe(URI.file('/a.ts').fsPath)
    expect(h.getBackStack().length).toBe(1)
    // The stale view is dropped instead of entering the forward stack.
    expect(forwardEditors(h).map((e) => e.resource.fsPath)).toEqual([
      URI.file('/c.ts').fsPath,
      URI.file('/b.ts').fsPath,
    ])
  })

  it('goBack returns undefined and leaves both stacks untouched when every landing is stale', () => {
    const h = makeHistoryService()
    h.recordView('a')
    h.recordView('b')
    h.recordView('c')
    let fired = 0
    h.onWillNavigate(() => fired++)
    expect(h.goBack({ isStale: () => true })).toBeUndefined()
    expect(fired).toBe(1)
    expect(h.getBackStack().length).toBe(3)
    expect(h.getForwardStack().length).toBe(0)
  })

  it('goForward skips stale entries and does not consume the count', () => {
    const h = makeHistoryService()
    for (const name of ['a', 'b', 'c', 'd']) h.record(entry(`/${name}.ts`, 1))
    h.goBack({ count: 3 }) // back = [a], forward = [d, c, b]
    const target = h.goForward({
      count: 2,
      // /c.ts is no longer navigable — drop it and keep walking.
      isStale: (e) => e.kind !== 'view' && e.resource.fsPath.endsWith('/c.ts'),
    })
    expect(editorEntry(target).resource.fsPath).toBe(URI.file('/d.ts').fsPath)
    expect(h.getForwardStack().length).toBe(0)
    expect(backEditors(h).map((e) => e.resource.fsPath)).toEqual([
      URI.file('/a.ts').fsPath,
      URI.file('/b.ts').fsPath,
      URI.file('/d.ts').fsPath,
    ])
  })

  it('a view landing sets no suppression window', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.recordView('explorer')
    h.record(entry('/b.ts', 1))
    const target = h.goBack()
    expect(target).toMatchObject({ kind: 'view', viewId: 'explorer' })
    // No window was opened for /b.ts, so this record is genuine navigation.
    h.record(entry('/b.ts', 1))
    expect(h.getForwardStack().length).toBe(0)
    expect(editorEntry(topOf(h.getBackStack())).resource.fsPath).toBe(URI.file('/b.ts').fsPath)
  })

  it('updateCurrent skips view entries and rewrites the editor entry below them', () => {
    const h = makeHistoryService()
    h.record(entry('/a.ts', 1))
    h.recordView('explorer')
    h.updateCurrent(URI.file('/a.ts'), {
      startLine: 9,
      startColumn: 2,
      endLine: 9,
      endColumn: 2,
    })
    expect(h.getBackStack().length).toBe(2)
    expect(h.getBackStack()[1]).toMatchObject({ kind: 'view' })
    expect(backEditors(h)[0]?.selection?.startLine).toBe(9)
  })
})
