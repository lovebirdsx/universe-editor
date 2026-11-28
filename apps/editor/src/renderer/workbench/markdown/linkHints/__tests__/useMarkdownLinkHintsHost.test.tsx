/*---------------------------------------------------------------------------------------------
 *  useMarkdownLinkHintsHost — focus registration and the context keys the
 *  global `f` / `F` link-hint commands gate on. A host that is not focused must
 *  not publish availability; focusing it must make `MarkdownPreviewRegistry`
 *  resolve to its controller, and content changes must dismiss live hints.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import {
  ContextKeyService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import { ServicesContext } from '../../../useService.js'
import { MarkdownPreviewRegistry } from '../../../../services/editor/MarkdownPreviewRegistry.js'
import {
  useMarkdownLinkHintsHost,
  type MarkdownLinkHintsHostState,
} from '../useMarkdownLinkHintsHost.js'

function rect(top: number, left: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => {
  cleanup()
  MarkdownPreviewRegistry._resetForTests()
})

function setup(initialSignature = 0) {
  const contextKeys = new ContextKeyService()
  const services = new ServiceCollection()
  services.set(IContextKeyService, contextKeys)
  const instantiation = new InstantiationService(services)
  let latest: MarkdownLinkHintsHostState | undefined

  function Host({ signature }: { readonly signature: number }) {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const state = useMarkdownLinkHintsHost({
      rootRef,
      registryUri: URI.parse('universe:/chat/session-1'),
      contentSignature: signature,
    })
    latest = state
    const setRef = (el: HTMLDivElement | null): void => {
      rootRef.current = el
      if (!el) return
      el.getBoundingClientRect = () => rect(0, 0, 1000, 1000)
      for (const anchor of el.querySelectorAll('a')) {
        anchor.getBoundingClientRect = () => rect(10, 10, 100, 20)
      }
    }
    return (
      <div ref={setRef} tabIndex={0} data-testid="root">
        <a href="https://example.com/a">a</a>
        <a href="https://example.com/b">b</a>
      </div>
    )
  }

  const view = render(
    <ServicesContext.Provider value={instantiation}>
      <Host signature={initialSignature} />
    </ServicesContext.Provider>,
  )
  return {
    contextKeys,
    root: view.getByTestId('root') as HTMLDivElement,
    state: () => latest!,
    rerender: (signature: number) =>
      view.rerender(
        <ServicesContext.Provider value={instantiation}>
          <Host signature={signature} />
        </ServicesContext.Provider>,
      ),
  }
}

function focusIn(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

function focusOut(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
  })
}

describe('useMarkdownLinkHintsHost', () => {
  it('publishes availability and registers the active controller on focus', () => {
    const { contextKeys, root } = setup()
    expect(contextKeys.get('markdownLinkHintsAvailable')).toBe(false)
    expect(MarkdownPreviewRegistry.getActive()).toBeUndefined()

    focusIn(root)
    expect(contextKeys.get('markdownLinkHintsAvailable')).toBe(true)
    expect(MarkdownPreviewRegistry.getActive()).toBeDefined()

    focusOut(root)
    expect(contextKeys.get('markdownLinkHintsAvailable')).toBe(false)
    expect(MarkdownPreviewRegistry.getActive()).toBeUndefined()
  })

  it('mirrors hint visibility into markdownPreviewLinkHintsVisible', () => {
    const { contextKeys, root, state } = setup()
    focusIn(root)
    const controller = MarkdownPreviewRegistry.getActive()!

    act(() => controller.showLinkHints(false))
    expect(state().linkHints.active).toBe(true)
    expect(contextKeys.get('markdownPreviewLinkHintsVisible')).toBe(true)

    act(() => controller.hideLinkHints())
    expect(state().linkHints.active).toBe(false)
    expect(contextKeys.get('markdownPreviewLinkHintsVisible')).toBe(false)
  })

  it('dismisses live hints when the content signature changes', () => {
    const { root, state, rerender } = setup(0)
    focusIn(root)
    act(() => MarkdownPreviewRegistry.getActive()!.showLinkHints(false))
    expect(state().linkHints.active).toBe(true)

    rerender(1)
    expect(state().linkHints.active).toBe(false)
  })
})
