/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useChatFind — the in-session find state machine for ChatScroll. A thin wrapper
 *  over the generic useFindInContainer hook, pinned to the ACP highlight names.
 *  See useFindInContainer for the matching/highlight mechanics.
 *
 *  ChatScroll disables virtualization while find is open so the walk covers the
 *  whole session, not just the rows in the overscan window.
 *--------------------------------------------------------------------------------------------*/

import { type MutableRefObject } from 'react'
import { useFindInContainer, type FindInContainerState } from '../editor/useFindInContainer.js'
import './chatFindHighlight.css'

export type ChatFind = FindInContainerState

const HIGHLIGHT_OPTIONS = { hlAll: 'acp-find-match', hlCurrent: 'acp-find-match-current' } as const

/**
 * @param containerRef the scroll container to search within.
 * @param contentSignature a value that changes whenever timeline content grows
 *   (streaming chunks / new messages); triggers a re-scan that keeps the user's
 *   current match instead of jumping back to the first.
 * @param onVisibleChange reports open/closed up so ChatScroll can de-virtualize
 *   and push `acpChatFindVisible` through the widget service.
 */
export function useChatFind<T extends HTMLElement>(
  containerRef: MutableRefObject<T | null>,
  contentSignature: unknown,
  onVisibleChange: (open: boolean) => void,
): ChatFind {
  return useFindInContainer(containerRef, contentSignature, HIGHLIGHT_OPTIONS, onVisibleChange)
}
