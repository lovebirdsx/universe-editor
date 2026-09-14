import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  EditorInput,
  URI,
  type IDisposable,
} from '@universe-editor/platform'
import {
  bridgeEditorColumnSelection,
  focusEditorInput,
  installEditorFocusDerivation,
  syncEditorFocusContext,
} from '../editorFocus.js'
import { FileEditorRegistry } from '../FileEditorRegistry.js'
import { DiffEditorRegistry } from '../DiffEditorRegistry.js'
import { MarkdownPreviewInput } from '../MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../MarkdownPreviewRegistry.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

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

describe('syncEditorFocusContext — editorTextFocus reset', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  // Regression: Monaco's onDidBlurEditorText subscription is disposed before the
  // editor when a FileEditor unmounts (e.g. a markdown source replaced by its
  // preview), so the blur never fires and editorTextFocus stays stuck true —
  // which made the global keybinding handler swallow printable keys like `f`.
  // syncEditorFocusContext must clear it whenever no Monaco editor holds focus.
  it('clears editorTextFocus when focus is outside any Monaco editor', () => {
    const cks = new ContextKeyService()
    cks.set('editorTextFocus', true)

    const preview = document.createElement('div')
    preview.tabIndex = 0
    document.body.appendChild(preview)
    preview.focus()

    syncEditorFocusContext(cks)

    expect(cks.get('editorFocus')).toBe(false)
    expect(cks.get('editorTextFocus')).toBe(false)
  })

  it('leaves editorTextFocus untouched while a Monaco editor holds focus', () => {
    const cks = new ContextKeyService()
    cks.set('editorTextFocus', true)

    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    const input = document.createElement('div')
    input.tabIndex = 0
    monaco.appendChild(input)
    document.body.appendChild(monaco)
    input.focus()

    syncEditorFocusContext(cks)

    expect(cks.get('editorFocus')).toBe(true)
    // Still focused in a Monaco editor: the text-vs-widget distinction stays
    // Monaco's job, so we must not clobber it here.
    expect(cks.get('editorTextFocus')).toBe(true)
  })
})

describe('installEditorFocusDerivation', () => {
  let derivation: IDisposable | undefined

  /** Monaco's editContext focus host: a child of the `.monaco-editor` node. */
  function mountMonacoFocusHost(): HTMLElement {
    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    const host = document.createElement('div')
    host.className = 'native-edit-context'
    host.tabIndex = 0
    editor.appendChild(host)
    document.body.appendChild(editor)
    return host
  }

  function mountFocusable(parent: HTMLElement = document.body): HTMLElement {
    const el = document.createElement('div')
    el.tabIndex = 0
    parent.appendChild(el)
    return el
  }

  /** The focusout pass defers by a macrotask; let it run. */
  const settleMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    derivation?.dispose()
    derivation = undefined
    document.body.innerHTML = ''
  })

  // Regression: the ACP prompt input's embedded Monaco reports focus through a host
  // inside `.monaco-editor`, but registered no `editorFocus` bridge — so once
  // focusEditorInput wrote true, moving on (to the Explorer) left it true and the
  // global Escape binding (`!editorFocus`) stopped matching.
  it('follows focus out of a Monaco editor and back', () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()

    host.focus()
    expect(cks.get('editorFocus')).toBe(true)

    mountFocusable().focus()
    expect(cks.get('editorFocus')).toBe(false)
  })

  it('starts reconciled with the DOM', () => {
    const cks = new ContextKeyService()
    cks.set('editorFocus', true)

    derivation = installEditorFocusDerivation(cks)

    // Nothing is focused yet (activeElement is <body>), so the stale true must go.
    expect(cks.get('editorFocus')).toBe(false)
  })

  // Focus dropping to <body> — a click on a non-focusable div — fires focusout with
  // no focusin behind it, and the key would stay stuck true without a pass of its
  // own. The read has to be deferred: while a focusout focusin pair is in flight
  // activeElement is momentarily null.
  it('reconciles when focus drops off Monaco without a focusin', async () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()

    host.focus()
    expect(cks.get('editorFocus')).toBe(true)

    host.blur()
    expect(document.activeElement).not.toBe(host)

    await settleMacrotask()

    expect(cks.get('editorFocus')).toBe(false)
  })

  // Why this derives from document focus events instead of IFocusTrackerService:
  // the tracker's settle pass sees the same element as before and stays silent, so
  // a key that went false while focus was on <body> would never come back true.
  it('recovers when focus returns to the element it left', async () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()

    host.focus()
    host.blur()
    await settleMacrotask()
    expect(cks.get('editorFocus')).toBe(false)

    host.focus()
    expect(cks.get('editorFocus')).toBe(true)
  })

  it('clears a stuck editorTextFocus once focus moves outside Monaco', () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    cks.set('editorTextFocus', true)

    mountFocusable().focus()

    expect(cks.get('editorTextFocus')).toBe(false)
  })

  it('leaves editorTextFocus to Monaco while an editor still holds focus', () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()

    host.focus()
    cks.set('editorTextFocus', true)
    // Focus moves within `.monaco-editor` (widget → widget): the text-vs-widget
    // split stays Monaco's job, so we must not clobber it here.
    const monacoRoot = host.parentElement as HTMLElement
    mountFocusable(monacoRoot).focus()

    expect(cks.get('editorFocus')).toBe(true)
    expect(cks.get('editorTextFocus')).toBe(true)
  })

  it('stops reconciling once disposed', () => {
    const cks = new ContextKeyService()
    derivation = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()
    cks.set('editorFocus', true)

    derivation.dispose()
    derivation = undefined

    host.focus()
    expect(cks.get('editorFocus')).toBe(true)

    mountFocusable().focus()
    expect(cks.get('editorFocus')).toBe(true)
  })

  it('cancels a pending focusout pass on dispose', async () => {
    const cks = new ContextKeyService()
    const disposable = installEditorFocusDerivation(cks)
    const host = mountMonacoFocusHost()

    host.focus()
    expect(cks.get('editorFocus')).toBe(true)

    host.blur()
    disposable.dispose()
    await settleMacrotask()

    expect(cks.get('editorFocus')).toBe(true)
  })
})

describe('bridgeEditorColumnSelection', () => {
  it('mirrors Monaco columnSelection option into the global context key', () => {
    const cks = new ContextKeyService()
    const option = 28
    const onDidChangeConfiguration = new Emitter<{ hasChanged(id: number): boolean }>()
    let enabled = false
    const editor = {
      getOption(id: number) {
        expect(id).toBe(option)
        return enabled
      },
      onDidChangeConfiguration: onDidChangeConfiguration.event,
    } as unknown as monaco.editor.IStandaloneCodeEditor
    const monacoNs = {
      editor: { EditorOption: { columnSelection: option } },
    } as unknown as typeof monaco

    const disposable = bridgeEditorColumnSelection(editor, monacoNs, cks)
    expect(cks.get('editorColumnSelection')).toBe(false)

    enabled = true
    onDidChangeConfiguration.fire({ hasChanged: (id) => id === option })
    expect(cks.get('editorColumnSelection')).toBe(true)

    enabled = false
    onDidChangeConfiguration.fire({ hasChanged: () => false })
    expect(cks.get('editorColumnSelection')).toBe(true)

    disposable.dispose()
    expect(cks.get('editorColumnSelection')).toBe(false)
  })
})

describe('focusEditorInput — markdown preview', () => {
  // Repro: pressing Esc inside a focused preview routes to FocusActiveEditorGroup
  // → focusEditorInput(MarkdownPreviewInput). Without a focus() hook this fell
  // through to focusGroupBody(), moving focus to the editor-group body that wraps
  // (and so sits outside) the preview container — firing the preview's focusout,
  // dropping markdownPreviewFocused, and silently disabling f / Ctrl+F. The hook
  // must instead route focus back into the preview's own scroll container.
  function makeController(): {
    controller: IMarkdownPreviewController
    calls: { focus: number }
  } {
    const calls = { focus: 0 }
    const onDidScroll = new Emitter<void>()
    const controller: IMarkdownPreviewController = {
      scrollToLine: () => {},
      scrollToAnchor: () => {},
      getTopVisibleLine: () => 1,
      isScrolledToBottom: () => false,
      focus: () => {
        calls.focus += 1
      },
      onDidScroll: onDidScroll.event,
      openFind: () => {},
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
      showLinkHints: () => {},
      hideLinkHints: () => {},
      toggleHelp: () => {},
    }
    return { controller, calls }
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    FileEditorRegistry._resetForTests()
    DiffEditorRegistry._resetForTests()
    MarkdownPreviewRegistry._resetForTests()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    MarkdownPreviewRegistry._resetForTests()
  })

  it('routes focus to the preview controller, not the group body', () => {
    const cks = new ContextKeyService()
    const body = mountGroupBody(5)
    const sourceUri = URI.file('/repo/doc.md')
    const input = new MarkdownPreviewInput(sourceUri)
    const { controller, calls } = makeController()
    MarkdownPreviewRegistry.register(sourceUri, controller)

    const handled = focusEditorInput(input, cks, 5)

    expect(handled).toBe(true)
    expect(calls.focus).toBe(1)
    // The group body must NOT have stolen focus (that is the regression).
    expect(document.activeElement).not.toBe(body)
  })

  it('falls back to the group body when no preview is mounted', () => {
    const cks = new ContextKeyService()
    const body = mountGroupBody(6)
    const input = new MarkdownPreviewInput(URI.file('/repo/doc.md'))

    // No controller registered: focus() returns false, so focusEditorInput
    // falls through to the group-body fallback (keyboard input still lands
    // somewhere sane).
    const handled = focusEditorInput(input, cks, 6)

    expect(handled).toBe(true)
    expect(document.activeElement).toBe(body)
  })
})
