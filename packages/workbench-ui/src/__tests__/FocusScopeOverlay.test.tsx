import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { StrictMode, useLayoutEffect, useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FocusScopeOverlay } from '../overlay/FocusScopeOverlay.js'
import { OwnerDocumentProvider } from '../overlay/ownerDocumentContext.js'
import { Select } from '../atoms/Select.js'

// The restore is deferred one microtask so StrictMode's rehearsal cleanup
// (immediately followed by a setup) restores nothing.
async function flushRestore(): Promise<void> {
  await Promise.resolve()
}

describe('FocusScopeOverlay', () => {
  afterEach(() => {
    cleanup()
    document.body.querySelectorAll('[data-floating-ui-portal]').forEach((n) => n.remove())
  })

  it('closes on Escape from inside the overlay', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <button data-testid="inside">inside</button>
      </FocusScopeOverlay>,
    )
    fireEvent.keyDown(screen.getByTestId('inside'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape aimed at a floating-ui popup rendered in a body-level portal', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <button data-testid="inside">inside</button>
      </FocusScopeOverlay>,
    )

    const portal = document.createElement('div')
    portal.setAttribute('data-floating-ui-portal', '')
    portal.innerHTML = '<div data-testid="popup" tabindex="-1"></div>'
    document.body.appendChild(portal)

    fireEvent.keyDown(portal.firstElementChild!, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  // The real shape of the problem: a themed Select inside a dialog. Its popup
  // lives in a body-level portal, so both the react-aria focus trap and the
  // overlay's own Escape handler used to fight it.
  it('lets a Select inside it open and close on Escape without closing the dialog', () => {
    const onEscape = vi.fn()
    render(
      <FocusScopeOverlay visible onEscape={onEscape}>
        <div role="dialog">
          <Select
            value="a"
            options={[
              { value: 'a', label: 'a' },
              { value: 'b', label: 'b' },
            ]}
            onChange={() => {}}
            data-testid="sel"
          />
        </div>
      </FocusScopeOverlay>,
    )

    fireEvent.click(screen.getByTestId('sel'))
    expect(screen.getByRole('listbox')).toBeTruthy()

    // A mouse-opened popup leaves focus on the trigger, so Escape is dispatched
    // there, not into the portal — the overlay must still keep out of the way.
    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(screen.getByTestId('sel'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  describe('restoreFocus gate', () => {
    function focusOutside(): HTMLButtonElement {
      const outside = document.createElement('button')
      outside.textContent = 'outside'
      document.body.appendChild(outside)
      outside.focus()
      return outside
    }

    afterEach(() => {
      document.body.querySelectorAll('button').forEach((node) => {
        if (node.textContent === 'outside') node.remove()
      })
    })

    it('restores focus when the gate allows it at unmount time', async () => {
      const outside = focusOutside()
      const { unmount } = render(
        <FocusScopeOverlay visible shouldRestoreFocus={() => true}>
          <button data-testid="inside">inside</button>
        </FocusScopeOverlay>,
      )

      unmount()
      await flushRestore()
      expect(document.activeElement).toBe(outside)
    })

    it('leaves focus alone when the gate declines at unmount time', async () => {
      const outside = focusOutside()
      const { unmount } = render(
        <FocusScopeOverlay visible shouldRestoreFocus={() => false}>
          <button data-testid="inside">inside</button>
        </FocusScopeOverlay>,
      )
      const inside = screen.getByTestId('inside')

      unmount()
      await flushRestore()
      expect(document.activeElement).not.toBe(outside)
      expect(document.activeElement).not.toBe(inside)
    })

    it('restores an element from another DOM realm', async () => {
      // 辅助窗口是独立 realm，previous-focus 元素对主 realm 的 HTMLElement
      // 构造器做 instanceof 会失败；这里用只带 nodeType/tagName 的形状对象
      // 建模，真实跨 realm 行为由辅助窗口 e2e 守护。
      const doc = document.implementation.createHTMLDocument('aux')
      const outside = {
        nodeType: 1,
        tagName: 'BUTTON',
        isConnected: true,
        focus: vi.fn(),
      }
      // Focus drops to <body> once the overlay unmounts, as in a real window.
      let active: unknown = outside
      Object.defineProperty(doc, 'activeElement', { get: () => active, configurable: true })

      const { unmount } = render(
        <FocusScopeOverlay visible targetDocument={doc} shouldRestoreFocus={() => true}>
          <button data-testid="inside">inside</button>
        </FocusScopeOverlay>,
      )

      unmount()
      active = doc.body
      await flushRestore()
      expect(outside.focus).toHaveBeenCalledTimes(1)
    })

    it('restores into an auxiliary document without an explicit gate', async () => {
      // react-aria's own restore target is seeded from the global document, so
      // an ungated overlay in another window used to hand focus back to main.
      const win = new Window()
      const doc = win.document as unknown as Document
      const outside = doc.createElement('button')
      outside.textContent = 'outside'
      doc.body.appendChild(outside)
      outside.focus()
      expect(doc.activeElement).toBe(outside)

      // Keep the restore target outside the React container: rendering into
      // `doc.body` directly would clear its existing children.
      const mount = doc.createElement('div')
      doc.body.appendChild(mount)
      const { unmount } = render(
        <FocusScopeOverlay visible targetDocument={doc}>
          <button data-testid="inside">inside</button>
        </FocusScopeOverlay>,
        { container: mount },
      )

      unmount()
      await flushRestore()
      expect(doc.activeElement).toBe(outside)
    })

    it('resolves the owner document from OwnerDocumentProvider', async () => {
      const win = new Window()
      const aux = win.document as unknown as Document
      const opener = aux.createElement('button')
      aux.body.appendChild(opener)
      opener.focus()
      const focusSpy = vi.spyOn(opener, 'focus')

      const container = aux.createElement('div')
      aux.body.appendChild(container)
      const { unmount } = render(
        <OwnerDocumentProvider targetDocument={aux}>
          <FocusScopeOverlay visible shouldRestoreFocus={() => true}>
            <button data-testid="inside">inside</button>
          </FocusScopeOverlay>
        </OwnerDocumentProvider>,
        { container },
      )

      unmount()
      await flushRestore()
      expect(focusSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ReactStrictMode mounts every component, runs its effects, then replays the
  // setup→cleanup→setup dance in dev. The cleanup must not consume the captured
  // restore target, or the real close later has nothing left to restore to.
  describe('restoreFocus under StrictMode', () => {
    function AutoFocusInput() {
      const ref = useRef<HTMLInputElement>(null)
      useLayoutEffect(() => {
        ref.current?.focus()
      }, [])
      return <input ref={ref} data-testid="inside-input" />
    }

    function Host({ visible }: { visible: boolean }) {
      return (
        <StrictMode>
          <div className="native-edit-context" tabIndex={0} data-testid="editor-host" />
          {visible ? (
            <FocusScopeOverlay visible shouldRestoreFocus={() => true}>
              <AutoFocusInput />
            </FocusScopeOverlay>
          ) : null}
        </StrictMode>
      )
    }

    it('restores focus after the rehearsal cleanup was skipped', async () => {
      const view = render(<Host visible={false} />)
      const editor = screen.getByTestId('editor-host')
      editor.focus()
      expect(document.activeElement).toBe(editor)

      view.rerender(<Host visible />)
      // The rehearsal must not hand focus back to the editor; the child's
      // layout effect owns focus for the whole open session.
      expect(document.activeElement).toBe(screen.getByTestId('inside-input'))

      view.rerender(<Host visible={false} />)
      await flushRestore()
      expect(document.activeElement).toBe(editor)
    })

    it('restores into an auxiliary document under StrictMode without a gate', async () => {
      const win = new Window()
      const doc = win.document as unknown as Document
      const outside = doc.createElement('button')
      outside.textContent = 'outside'
      doc.body.appendChild(outside)
      outside.focus()
      expect(doc.activeElement).toBe(outside)

      const mount = doc.createElement('div')
      doc.body.appendChild(mount)
      const view = render(
        <StrictMode>
          <FocusScopeOverlay visible targetDocument={doc}>
            <AutoFocusInput />
          </FocusScopeOverlay>
        </StrictMode>,
        { container: mount },
      )
      expect(doc.activeElement).toBe(mount.querySelector('input'))

      view.unmount()
      await flushRestore()
      expect(doc.activeElement).toBe(outside)
    })
  })
})
