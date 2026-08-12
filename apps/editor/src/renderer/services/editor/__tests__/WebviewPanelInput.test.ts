/*---------------------------------------------------------------------------------------------
 *  Tests for WebviewPanelInput: identity isolation by panelHandle, transient
 *  (no serialize), and the title → label rename hook.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { WebviewPanelInput } from '../WebviewPanelInput.js'

function makeInput(panelHandle: number, title = 'A'): WebviewPanelInput {
  return new WebviewPanelInput(
    panelHandle,
    'cat.view',
    title,
    URI.from({ scheme: 'webview-panel', path: `/${panelHandle}` }),
  )
}

describe('WebviewPanelInput', () => {
  it('isolates identity per panelHandle so distinct panels never dedupe', () => {
    expect(makeInput(-1).id).toBe('webviewPanel:-1')
    expect(makeInput(-2).id).toBe('webviewPanel:-2')
    expect(makeInput(-1).id).not.toBe(makeInput(-2).id)
  })

  it('has the webviewPanel typeId and no file resource', () => {
    const input = makeInput(-1)
    expect(input.typeId).toBe('webviewPanel')
    expect(input.resource).toBeUndefined()
  })

  it('exposes viewType and the shared focus resource', () => {
    const resource = URI.from({ scheme: 'webview-panel', path: '/-7' })
    const input = new WebviewPanelInput(-7, 'cat.view', 'A', resource)
    expect(input.viewType).toBe('cat.view')
    expect(input.focusResource.toString()).toBe(resource.toString())
  })

  it('is transient — no serialize, so a window restore drops the tab', () => {
    expect(makeInput(-1).serialize).toBeUndefined()
  })

  it('setTitle renames the label and fires onDidChangeLabel only on change', () => {
    const input = makeInput(-1, 'Old')
    let fired = 0
    input.onDidChangeLabel(() => fired++)

    input.setTitle('New')
    expect(input.getName()).toBe('New')
    expect(fired).toBe(1)

    input.setTitle('New') // no change → no event
    expect(fired).toBe(1)
  })
})
