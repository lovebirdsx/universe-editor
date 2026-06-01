/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import type { AcpToolCall, TimelineItem } from '../../../services/acp/acpSession.js'
import { StickyScrollOverlay } from '../StickyScrollOverlay.js'
import type { CollapseState } from '../timelineCollapse.js'

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

function rectOf(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  }
}

function stubRect(el: Element, top: number, bottom: number): void {
  el.getBoundingClientRect = () => rectOf(top, bottom)
}

/** Build a detached scroll container with sticky cards at the given geometry. */
function buildContainer(
  cards: { key: string; depth: number; top: number; bottom: number; headerHeight: number }[],
  scrollTop: number,
  clientHeight = 600,
): HTMLDivElement {
  const container = document.createElement('div')
  stubRect(container, 0, clientHeight)
  Object.defineProperty(container, 'scrollTop', { value: scrollTop, writable: true })
  Object.defineProperty(container, 'clientHeight', { value: clientHeight })
  const nodeByKey = new Map<string, HTMLElement>()
  for (const c of cards) {
    const node = document.createElement('div')
    node.dataset['stickyKey'] = c.key
    node.dataset['stickyDepth'] = String(c.depth)
    // viewport rect = content rect - scrollTop
    stubRect(node, c.top - scrollTop, c.bottom - scrollTop)
    const btn = document.createElement('button')
    btn.dataset['testid'] = 'acp-collapsible-toggle'
    btn.setAttribute('data-testid', 'acp-collapsible-toggle')
    stubRect(btn, 0, c.headerHeight)
    node.appendChild(btn)
    // Nest depth>0 cards inside their parent so querySelectorAll and
    // `:scope > button` mirror the real DOM tree.
    const parentNode = c.depth > 0 ? findParent(nodeByKey, c) : undefined
    ;(parentNode ?? container).appendChild(node)
    nodeByKey.set(c.key, node)
  }
  document.body.appendChild(container)
  return container
}

function findParent(
  nodeByKey: Map<string, HTMLElement>,
  c: { key: string; depth: number },
): HTMLElement | undefined {
  const parentKey = c.key.split('/').slice(0, -1).join('/')
  return nodeByKey.get(parentKey)
}

function toolCall(id: string, over: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id,
    title: `tool ${id}`,
    kind: 'execute',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...over,
  }
}

function toolItem(id: string, over?: Partial<AcpToolCall>): TimelineItem {
  return { kind: 'toolCall', id, call: toolCall(id, over) }
}

const COLLAPSE: CollapseState = { mode: 'default', overrides: new Map() }

describe('StickyScrollOverlay', () => {
  it('pins a single containing card and wires its actions', async () => {
    const container = buildContainer(
      [{ key: 't:a', depth: 0, top: 0, bottom: 500, headerHeight: 24 }],
      100,
    )
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = container
    const onToggle = vi.fn()
    const onJump = vi.fn()

    const { findByTestId } = render(
      <StickyScrollOverlay
        containerRef={ref}
        timeline={[toolItem('a')]}
        collapse={COLLAPSE}
        onToggleCollapse={onToggle}
        onJumpTo={onJump}
        revision={0}
      />,
    )

    const header = await findByTestId('acp-sticky-header')
    expect(header.textContent).toContain('tool a')

    fireEvent.click(await findByTestId('acp-sticky-toggle'))
    expect(onToggle).toHaveBeenCalledWith('t:a')

    fireEvent.click(await findByTestId('acp-sticky-jump'))
    expect(onJump).toHaveBeenCalledWith('t:a')
  })

  it('stacks a nested child header below its ancestor', async () => {
    const container = buildContainer(
      [
        { key: 't:a', depth: 0, top: 0, bottom: 800, headerHeight: 24 },
        { key: 't:a/t:b', depth: 1, top: 200, bottom: 700, headerHeight: 20 },
      ],
      300,
    )
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = container

    const timeline = [
      toolItem('a', { children: [{ kind: 'toolCall', id: 'b', call: toolCall('b') }] }),
    ]
    const { findAllByTestId } = render(
      <StickyScrollOverlay
        containerRef={ref}
        timeline={timeline}
        collapse={COLLAPSE}
        onToggleCollapse={vi.fn()}
        onJumpTo={vi.fn()}
        revision={0}
      />,
    )

    await waitFor(async () => {
      const headers = await findAllByTestId('acp-sticky-header')
      expect(headers).toHaveLength(2)
    })
    const headers = await findAllByTestId('acp-sticky-header')
    expect(headers[0]!.textContent).toContain('tool a')
    expect(headers[1]!.textContent).toContain('tool b')
  })
})
