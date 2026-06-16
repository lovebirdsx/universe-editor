import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextKeyService, EditorInput, URI } from '@universe-editor/platform'
import { focusEditorInput } from '../editorFocus.js'
import { FileEditorRegistry } from '../FileEditorRegistry.js'
import { DiffEditorRegistry } from '../DiffEditorRegistry.js'

class NonMonacoInput extends EditorInput {
  get typeId() {
    return 'gitGraph'
  }
  get resource() {
    return URI.from({ scheme: 'universe', path: '/gitGraph' })
  }
  getName() {
    return 'Git Graph'
  }
}

class SelfFocusingInput extends EditorInput {
  focused = false
  get typeId() {
    return 'acp.session'
  }
  get resource() {
    return URI.from({ scheme: 'universe', path: '/acp/session/1' })
  }
  getName() {
    return 'Session'
  }
  override focus(): boolean {
    this.focused = true
    return true
  }
}

function mountGroupBody(groupId: number): HTMLElement {
  const group = document.createElement('div')
  group.setAttribute('data-group-id', String(groupId))
  const body = document.createElement('div')
  body.setAttribute('data-testid', 'editor-group-body')
  body.tabIndex = -1
  group.appendChild(body)
  document.body.appendChild(group)
  return body
}

describe('focusEditorInput — non-Monaco editors', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FileEditorRegistry._resetForTests()
    DiffEditorRegistry._resetForTests()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  // Repro: a non-text editor (Git Graph) with no Monaco registration and no
  // focus() hook used to leave DOM focus wherever it was — e.g. the terminal —
  // so terminalFocus stayed true and Ctrl+W (when="!terminalFocus") never fired.
  it('moves DOM focus into the group body for a non-Monaco editor without focus()', () => {
    const cks = new ContextKeyService()
    const body = mountGroupBody(7)

    // Simulate the terminal owning focus before restore activates the editor.
    const terminalHost = document.createElement('div')
    terminalHost.tabIndex = 0
    document.body.appendChild(terminalHost)
    terminalHost.focus()
    expect(document.activeElement).toBe(terminalHost)

    const handled = focusEditorInput(new NonMonacoInput(), cks, 7)

    expect(handled).toBe(true)
    expect(document.activeElement).toBe(body)
  })

  it('delegates to input.focus() when the editor manages its own focus', () => {
    const cks = new ContextKeyService()
    mountGroupBody(3)
    const input = new SelfFocusingInput()

    const handled = focusEditorInput(input, cks, 3)

    expect(handled).toBe(true)
    expect(input.focused).toBe(true)
  })

  it('returns false when no group body is present and the editor cannot self-focus', () => {
    const cks = new ContextKeyService()
    expect(focusEditorInput(new NonMonacoInput(), cks, 99)).toBe(false)
  })
})
