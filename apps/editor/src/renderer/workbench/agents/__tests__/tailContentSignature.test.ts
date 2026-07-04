/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression for the "Edit card only shows half" bug: while the view is
 *  bottom-pinned, ChatBody re-runs the stick-to-bottom effect on changes to
 *  `timeline.length` OR `tailContentSignature(timeline)`. An Edit card is the only
 *  tool card that starts expanded by default, and its bulk (the InlineDiffPreview
 *  body) lives in `call.diffs` — NOT in `call.text`. So a `tool_call_update` that
 *  streams the diff in while leaving text/status unchanged must still change the
 *  signature, or the pin never re-fires and the freshly-grown diff sits below the
 *  fold until the next (non-edit) card bumps `timeline.length`.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { tailContentSignature } from '../ChatBody.js'
import type { AcpToolCall, TimelineItem } from '../../../services/acp/acpSessionService.js'

function editSlot(diffs: AcpToolCall['diffs']): TimelineItem {
  const call: AcpToolCall = {
    id: 'tc1',
    title: 'Edit src/foo.ts',
    kind: 'edit',
    status: 'completed',
    // The diff text is deliberately NOT folded into `text` (see splitToolCallContent).
    text: 'Edit src/foo.ts',
    blocks: [],
    diffs,
  }
  return { kind: 'toolCall', id: call.id, call }
}

describe('tailContentSignature — edit card diff growth', () => {
  it('changes when a diff is attached to the tail edit card', () => {
    const before = tailContentSignature([editSlot([])])
    const after = tailContentSignature([
      editSlot([{ path: 'src/foo.ts', oldText: 'a\nb', newText: 'a\nB\nc' }]),
    ])
    expect(after).not.toBe(before)
  })

  it('changes when the tail edit card diff grows across updates', () => {
    const small = tailContentSignature([
      editSlot([{ path: 'src/foo.ts', oldText: '', newText: 'line1' }]),
    ])
    const grown = tailContentSignature([
      editSlot([{ path: 'src/foo.ts', oldText: '', newText: 'line1\nline2\nline3\nline4' }]),
    ])
    expect(grown).not.toBe(small)
  })
})
