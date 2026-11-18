/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The `/`/`?` search box: an editor overlay widget that looks like Monaco's
 *  find widget but is driven by the Vim controller. It intentionally contains a
 *  real input so the native IME works; focusing it moves text focus out of
 *  Monaco, which makes the Vim registry stop routing keys until the box closes.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { monaco } from '../monaco/MonacoLoader.js'
import { searchPrefix } from './vimSearch.js'
import type { VimEditor, VimSearchDirection } from './vimTypes.js'
import './vimSearch.css'

export interface VimSearchWidget {
  readonly input: HTMLInputElement
  setDirection(direction: VimSearchDirection): void
  setValue(value: string): void
  showHint(text: string): void
  clearHint(): void
  show(): void
  hide(): void
  dispose(): void
}

export function createVimSearchWidget(editor: VimEditor): VimSearchWidget {
  const doc = editor.getContainerDomNode().ownerDocument
  const node = doc.createElement('div')
  node.className = 'vim-search-widget'
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

  node.append(prefix, input, hint)

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
    setDirection(direction) {
      prefix.textContent = searchPrefix(direction)
    },
    setValue(value) {
      input.value = value
    },
    showHint(text) {
      hint.textContent = text
    },
    clearHint() {
      hint.textContent = ''
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
