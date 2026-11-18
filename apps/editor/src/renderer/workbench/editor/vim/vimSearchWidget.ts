/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The `/`/`?` search box: an editor overlay widget that matches Monaco's find
 *  widget in size and colors but is driven by the Vim controller. It
 *  intentionally contains a real input so the native IME works; focusing it
 *  moves text focus out of Monaco, which makes the Vim registry stop routing
 *  keys until the box closes.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { monaco } from '../monaco/MonacoLoader.js'
import { searchPrefix, type VimSearchCaseMode, type VimSearchCaseSource } from './vimSearch.js'
import type { VimEditor, VimSearchDirection } from './vimTypes.js'
import './vimSearch.css'

export interface VimSearchCaseState {
  readonly caseSensitive: boolean
  readonly caseMode: VimSearchCaseMode
  readonly caseSource: VimSearchCaseSource
}

export interface VimSearchWidget {
  readonly input: HTMLInputElement
  readonly caseButton: HTMLButtonElement
  setDirection(direction: VimSearchDirection): void
  setValue(value: string): void
  setCaseState(state: VimSearchCaseState): void
  showHint(text: string): void
  clearHint(): void
  show(): void
  hide(): void
  dispose(): void
}

function caseModeLabel(mode: VimSearchCaseMode): string {
  switch (mode) {
    case 'sensitive':
      return localize('vim.search.caseMode.sensitive', 'Match case')
    case 'insensitive':
      return localize('vim.search.caseMode.insensitive', 'Ignore case')
    default:
      return localize('vim.search.caseMode.smart', 'Smart case')
  }
}

function effectiveCaseLabel(state: VimSearchCaseState): string {
  if (state.caseSource === 'default') return caseModeLabel(state.caseMode)
  return caseModeLabel(state.caseSensitive ? 'sensitive' : 'insensitive')
}

export function createVimSearchWidget(editor: VimEditor): VimSearchWidget {
  const doc = editor.getContainerDomNode().ownerDocument
  const node = doc.createElement('div')
  node.className = 'vim-search-widget'
  node.setAttribute('role', 'search')
  node.hidden = true

  const prefix = doc.createElement('span')
  prefix.className = 'vim-search-prefix'
  const input = doc.createElement('input')
  input.className = 'vim-search-input'
  input.type = 'text'
  input.setAttribute('aria-label', localize('vim.search.ariaLabel', 'Vim search'))
  input.spellcheck = false
  input.autocomplete = 'off'
  const hint = doc.createElement('span')
  hint.className = 'vim-search-hint'
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  const caseButton = doc.createElement('button')
  caseButton.className = 'vim-search-case'
  caseButton.type = 'button'
  caseButton.tabIndex = -1
  caseButton.textContent = 'Aa'
  caseButton.setAttribute('aria-label', localize('vim.search.caseLabel', 'Match case'))
  caseButton.setAttribute('aria-pressed', 'false')

  node.append(prefix, input, hint, caseButton)

  // Keep focus in the input: a mousedown on the button would otherwise blur the
  // input first and the controller's blur handler would commit and close the box.
  node.addEventListener('mousedown', (event) => {
    if (event.target === caseButton) event.preventDefault()
  })

  const overlay: monaco.editor.IOverlayWidget = {
    getId: () => 'vim-search-widget',
    getDomNode: () => node,
    // OverlayWidgetPositionPreference.TOP_RIGHT_CORNER; importing Monaco for the
    // enum value would load the editor bundle eagerly, so the number is inline.
    getPosition: () => ({ preference: 0 }),
  }

  let added = false
  let disposed = false

  return {
    input,
    caseButton,
    setDirection(direction) {
      prefix.textContent = searchPrefix(direction)
    },
    setValue(value) {
      input.value = value
      input.setSelectionRange(value.length, value.length)
    },
    setCaseState(state) {
      const label = effectiveCaseLabel(state)
      caseButton.setAttribute('aria-pressed', state.caseSensitive ? 'true' : 'false')
      caseButton.setAttribute('aria-label', label)
      caseButton.title = localize(
        'vim.search.caseTooltip',
        'Case sensitivity: {mode} (click to toggle)',
        { mode: label },
      )
    },
    showHint(text) {
      hint.textContent = text
      hint.title = text
    },
    clearHint() {
      hint.textContent = ''
      hint.title = ''
    },
    show() {
      if (disposed) return
      if (!added) {
        editor.addOverlayWidget(overlay)
        added = true
      }
      node.hidden = false
    },
    hide() {
      node.hidden = true
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (!added) return
      added = false
      try {
        editor.removeOverlayWidget(overlay)
      } catch {
        /* editor already disposed */
      }
    },
  }
}
