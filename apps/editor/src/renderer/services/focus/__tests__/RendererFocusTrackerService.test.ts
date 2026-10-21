/*---------------------------------------------------------------------------------------------
 *  RendererFocusTrackerService — 焦点历史跨所有 workbench document。
 *
 *  编辑器组可以渲染进辅助窗口，其焦点事件不会到达主文档。文档注销后也不能
 *  让 current / pending 继续指向已销毁的 DOM。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { RendererFocusTrackerService } from '../RendererFocusTrackerService.js'
import { registerWorkbenchDocument } from '../../windows/workbenchDocuments.js'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function focusIn(element: HTMLElement): void {
  element.focus()
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}

function makeAuxButton(win: Window): HTMLButtonElement {
  const button = win.document.createElement('button')
  win.document.body.appendChild(button)
  return button as unknown as HTMLButtonElement
}

describe('RendererFocusTrackerService — workbench documents', () => {
  it('settles on focus inside a registered auxiliary document', () => {
    vi.useFakeTimers()
    const win = new Window()
    const auxDoc = win.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const button = makeAuxButton(win)
      focusIn(button)
      vi.runAllTimers()

      expect(service.current).toBe(button)
      expect(events).toEqual([button])
    } finally {
      service.dispose()
      auxRegistration.dispose()
      mainRegistration.dispose()
    }
  })

  it('reconciles the current focus to another document when its document is unregistered', () => {
    vi.useFakeTimers()
    const win = new Window()
    const auxDoc = win.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const mainButton = document.createElement('button')
      document.body.appendChild(mainButton)
      mainButton.focus()

      const auxButton = makeAuxButton(win)
      focusIn(auxButton)
      vi.runAllTimers()
      expect(service.current).toBe(auxButton)
      events.length = 0

      auxRegistration.dispose()

      // 同步协调，不依赖未决的 settle 定时器。
      expect(service.current).toBe(mainButton)
      expect(events).toEqual([mainButton])

      // 注销后不再接收该文档的焦点事件。
      const second = makeAuxButton(win)
      focusIn(second)
      vi.runAllTimers()
      expect(service.current).toBe(mainButton)
      expect(events).toEqual([mainButton])
    } finally {
      service.dispose()
      mainRegistration.dispose()
    }
  })

  it('keeps a still-pending focus target from another document on removal', () => {
    vi.useFakeTimers()
    const win = new Window()
    const auxDoc = win.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const auxButton = makeAuxButton(win)
      focusIn(auxButton)
      vi.runAllTimers()
      expect(service.current).toBe(auxButton)

      const mainButton = document.createElement('button')
      document.body.appendChild(mainButton)
      mainButton.focus()
      // 只调度、不 settle：注销必须先采用这个仍有效的目标。
      mainButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

      auxRegistration.dispose()

      expect(service.current).toBe(mainButton)
      expect(events).toEqual([auxButton, mainButton])

      // 定时器已同步清掉，不会重复释放一次事件。
      vi.runAllTimers()
      expect(events).toEqual([auxButton, mainButton])
    } finally {
      service.dispose()
      mainRegistration.dispose()
    }
  })

  it('keeps the current element when the pending target lived in the removed document', () => {
    vi.useFakeTimers()
    const first = new Window()
    const second = new Window()
    const firstDoc = first.document as unknown as Document
    const secondDoc = second.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const firstRegistration = registerWorkbenchDocument(firstDoc)
    const secondRegistration = registerWorkbenchDocument(secondDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const firstButton = makeAuxButton(first)
      focusIn(firstButton)
      vi.runAllTimers()
      expect(service.current).toBe(firstButton)

      const secondButton = makeAuxButton(second)
      focusIn(secondButton)
      // 尚未 settle，焦点“正在移入”第二个文档；此时该文档被注销。
      secondRegistration.dispose()

      expect(service.current).toBe(firstButton)
      expect(events).toEqual([firstButton])

      firstRegistration.dispose()
      expect(service.current).toBeNull()
    } finally {
      service.dispose()
      mainRegistration.dispose()
    }
  })

  it('does not fire or move focus when a non-current document is unregistered', () => {
    vi.useFakeTimers()
    const win = new Window()
    const auxDoc = win.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const auxButton = makeAuxButton(win)
      focusIn(auxButton)
      vi.runAllTimers()
      expect(service.current).toBe(auxButton)
      events.length = 0

      mainRegistration.dispose()

      expect(service.current).toBe(auxButton)
      expect(events).toEqual([])
    } finally {
      service.dispose()
      auxRegistration.dispose()
    }
  })

  it('does not emit after disposal while a settle is pending', () => {
    vi.useFakeTimers()
    const win = new Window()
    const auxDoc = win.document as unknown as Document
    const mainRegistration = registerWorkbenchDocument(document)
    const auxRegistration = registerWorkbenchDocument(auxDoc)
    const service = new RendererFocusTrackerService(document)
    try {
      const events: unknown[] = []
      service.onDidFocusChange((e) => events.push(e.current))

      const button = makeAuxButton(win)
      focusIn(button)

      service.dispose()
      vi.runAllTimers()

      expect(events).toEqual([])
    } finally {
      auxRegistration.dispose()
      mainRegistration.dispose()
    }
  })
})
