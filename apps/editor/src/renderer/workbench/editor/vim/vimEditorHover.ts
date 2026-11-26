/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Monaco's content hover hides itself only from `editor.onKeyDown` (plus mouse,
 *  scroll and model change), never from cursor movement. Vim consumes keystrokes
 *  on window capture before Monaco's listeners run, so the controller must dismiss
 *  it explicitly. The contribution access mirrors vimViewport: a private Monaco id
 *  behind a local interface, so an upstream rename degrades to "hover stays
 *  visible" instead of throwing.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../monaco/MonacoLoader.js'
import { SHOW_HOVER_COMMAND_ID } from './vimKeymap.js'
import type { VimCommand, VimEditor } from './vimTypes.js'

const CONTENT_HOVER_CONTRIBUTION_ID = 'editor.contrib.contentHover'
const HIDE_HOVER_COMMAND_ID = 'editor.action.hideHover'

interface ContentHoverContribution extends monaco.editor.IEditorContribution {
  readonly isHoverVisible?: boolean
}

export function isShowHoverCommand(command: VimCommand | null): boolean {
  return command?.type === 'editor-command' && command.commandId === SHOW_HOVER_COMMAND_ID
}

export function isContentHoverVisible(editor: VimEditor): boolean {
  return (
    editor.getContribution?.<ContentHoverContribution>(CONTENT_HOVER_CONTRIBUTION_ID)
      ?.isHoverVisible === true
  )
}

/** Hide the content hover if it is visible; returns whether there was one. */
export function dismissContentHover(editor: VimEditor): boolean {
  if (!isContentHoverVisible(editor)) return false
  editor.trigger('vim', HIDE_HOVER_COMMAND_ID, null)
  return true
}
