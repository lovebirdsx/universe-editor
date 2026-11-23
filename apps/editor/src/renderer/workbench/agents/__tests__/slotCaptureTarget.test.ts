/*---------------------------------------------------------------------------------------------
 *  Capture-target lookup: body resolution by slot key, the bounded wait after a
 *  temporary expand, and the user-message clamp release.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandCollapsedUserBodies, findSlotBody, waitForSlotBody } from '../slotCaptureTarget.js'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mount(container: HTMLElement): void {
  document.body.append(container)
}

function makeContainer(): HTMLElement {
  const container = document.createElement('div')
  container.setAttribute('data-testid', 'acp-chat')
  return container
}

function makeRow(attribute: 'data-timeline-key' | 'data-sticky-key', key: string): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute(attribute, key)
  return row
}

function makeBody(): HTMLElement {
  const body = document.createElement('div')
  body.setAttribute('data-testid', 'acp-collapsible-body')
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({
    width: 200,
    height: 100,
    top: 0,
    left: 0,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return body
}

describe('findSlotBody', () => {
  it('finds the body under a timeline row', () => {
    const container = makeContainer()
    const row = makeRow('data-timeline-key', 'm:a')
    const body = makeBody()
    row.append(body)
    container.append(row)
    mount(container)

    expect(findSlotBody(container, 'm:a')).toBe(body)
  })

  it('falls back to the sticky key used by nested and sticky-bar cards', () => {
    const container = makeContainer()
    const row = makeRow('data-sticky-key', 'm:sticky')
    const body = makeBody()
    row.append(body)
    container.append(row)
    mount(container)

    expect(findSlotBody(container, 'm:sticky')).toBe(body)
  })

  it('returns undefined when the row is not mounted', () => {
    const container = makeContainer()
    mount(container)
    expect(findSlotBody(container, 'm:gone')).toBeUndefined()
  })
})

describe('waitForSlotBody', () => {
  it('returns an already mounted body immediately', async () => {
    const container = makeContainer()
    const row = makeRow('data-timeline-key', 'm:a')
    const body = makeBody()
    row.append(body)
    container.append(row)
    mount(container)

    await expect(waitForSlotBody(container, 'm:a', 100)).resolves.toBe(body)
  })

  it('waits for the body a temporary expand mounts', async () => {
    const container = makeContainer()
    const row = makeRow('data-timeline-key', 'm:a')
    container.append(row)
    mount(container)

    const pending = waitForSlotBody(container, 'm:a', 500)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const body = makeBody()
    row.append(body)

    await expect(pending).resolves.toBe(body)
  })

  it('gives up when the container is disconnected', async () => {
    const container = makeContainer()
    await expect(waitForSlotBody(container, 'm:a', 100)).resolves.toBeUndefined()
  })

  it('gives up quickly when the row disappears', async () => {
    const container = makeContainer()
    mount(container)
    const started = Date.now()

    await expect(waitForSlotBody(container, 'm:gone', 1000)).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('expandCollapsedUserBodies', () => {
  it('releases clamped user messages and restores them', () => {
    const root = document.createElement('div')
    const body = document.createElement('div')
    body.setAttribute('data-testid', 'acp-user-message-body')
    body.setAttribute('data-collapsed', 'true')
    root.append(body)

    const restore = expandCollapsedUserBodies(root)
    expect(body.getAttribute('data-collapsed')).toBe('false')

    restore()
    expect(body.getAttribute('data-collapsed')).toBe('true')
  })

  it('leaves already expanded bodies untouched', () => {
    const root = document.createElement('div')
    const body = document.createElement('div')
    body.setAttribute('data-testid', 'acp-user-message-body')
    body.setAttribute('data-collapsed', 'false')
    root.append(body)

    expandCollapsedUserBodies(root)()
    expect(body.getAttribute('data-collapsed')).toBe('false')
  })
})
