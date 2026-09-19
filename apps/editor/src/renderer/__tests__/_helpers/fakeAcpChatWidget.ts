/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  A complete `AcpChatWidget` stub for tests. The interface grows every time a
 *  chat-scoped command is added, and the four hand-written literals this
 *  replaces had to be edited in lockstep or typecheck failed — one member at a
 *  time, in several files. Build the fake here and override only what a test
 *  actually asserts on.
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest'
import type { AcpChatWidget } from '../../services/acp/session/acpChatWidgetService.js'

export function makeFakeAcpChatWidget(overrides: Partial<AcpChatWidget> = {}): AcpChatWidget {
  return {
    container: document.createElement('div'),
    moveTimeline: vi.fn(),
    moveTimelineLevel: vi.fn(),
    scrollTimeline: vi.fn(),
    focusInput: vi.fn(() => false),
    focusTimeline: vi.fn(() => false),
    activateConfigEntry: vi.fn(() => false),
    getFocusSurface: () => 'prompt' as const,
    jumpToPlan: vi.fn(),
    toggleCollapse: vi.fn(),
    setSlotCollapsed: vi.fn(),
    isSlotCollapsed: vi.fn(() => false),
    cycleCollapseMode: vi.fn(),
    getFocusedText: vi.fn(),
    popoverSelectNext: vi.fn(),
    popoverSelectPrev: vi.fn(),
    popoverAccept: vi.fn(),
    popoverHide: vi.fn(),
    openFind: vi.fn(),
    closeFind: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
    ...overrides,
  }
}
