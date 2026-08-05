/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  timelineFollowTarget — decides what the Timeline view should follow when the
 *  active editor changes. A virtual editor (graph, settings, welcome — anything
 *  getOriginalResource maps to undefined) keeps the timeline on the previous
 *  file instead of blanking it (VSCode parity); only having no active editor at
 *  all clears the view.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IEditorInput } from '@universe-editor/platform'
import { getOriginalResource } from '../editor/editorResourceAccessor.js'

/** `URI` — follow that file; `undefined` — clear; `'keep'` — retain current file. */
export type TimelineFollowTarget = URI | undefined | 'keep'

export function timelineFollowTarget(
  editor: IEditorInput | undefined | null,
): TimelineFollowTarget {
  if (editor == null) return undefined
  return getOriginalResource(editor) ?? 'keep'
}
