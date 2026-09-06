/*---------------------------------------------------------------------------------------------
 *  Regression: the probe results list renders without a React key warning.
 *
 *  `VirtualList`'s default (non-measuring) branch returns `renderItem`'s result
 *  verbatim, so the row root owns the React key. This dialog passed `getItemKey`
 *  and assumed that covered it — but `getItemKey` only feeds the virtualizer's
 *  index identity and never becomes a React key, so every render of the list
 *  logged "Each child in a list should have a unique key prop. Check the render
 *  method of `ForwardRef(VirtualListInner)`" and reconciled rows positionally
 *  (which, on a filterable list of checkboxes, means ticks can follow the slot
 *  rather than the model).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { IAiModelService } from '@universe-editor/platform'
import { ProbeModelsDialog } from '../ProbeModelsDialog.js'

const MODEL_IDS = ['acme-chat-pro', 'acme-chat-lite', 'acme-reasoner']

function fakeService(ids: readonly string[]): IAiModelService {
  return {
    verifyProvider: vi.fn(() =>
      Promise.resolve({ ok: true, modelCount: ids.length, modelIds: [...ids] }),
    ),
  } as unknown as IAiModelService
}

let errors: string[]

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '))
  })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  // happy-dom has no layout engine, so every element measures 0, the virtualizer
  // windows down to zero rows, and the assertion below would pass for the wrong
  // reason. @tanstack/react-virtual sizes its scroller from offsetWidth/Height
  // (not getBoundingClientRect), so those are what have to answer.
  for (const prop of ['offsetHeight', 'offsetWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 400 })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  // Safe to delete rather than restore: happy-dom defines these on the prototype
  // as configurable getters, and each test file gets a fresh Window, so removing
  // the override uncovers the native descriptor again.
  for (const prop of ['offsetHeight', 'offsetWidth'] as const) {
    Reflect.deleteProperty(HTMLElement.prototype, prop)
  }
  cleanup()
})

describe('ProbeModelsDialog row keys', () => {
  it('renders the probed models without a duplicate-key warning', async () => {
    render(
      <ProbeModelsDialog
        aiModel={fakeService(MODEL_IDS)}
        provider={{ id: 'acme' }}
        protocol="openai-chat"
        connection={{ baseUrl: 'https://gallery.example.com/v1', apiKey: 'ak-1' }}
        declared={[]}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    )

    for (const id of MODEL_IDS) {
      await waitFor(() => expect(screen.getByLabelText(id)).toBeTruthy())
    }
    expect(errors.filter((e) => e.includes('unique "key" prop'))).toEqual([])
  })
})
