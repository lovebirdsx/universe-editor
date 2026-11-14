/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerSessionRevealService: only a trigger that set showSession reveals,
 *  only a visible window reveals, the durable id resolves to the live local session
 *  id, and hidden windows are left alone.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroupsService, IInstantiationService } from '@universe-editor/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IAcpChatWidgetService } from '../../acp/session/acpChatWidgetService.js'
import type { IAcpSession } from '../../acp/session/acpSessionModel.js'
import type { IAcpSessionService } from '../../acp/session/acpSessionService.js'
import { revealSessionChat } from '../../acp/session/revealSessionChat.js'
import type { IWindowFocusService } from '../../windows/windowFocusService.js'
import { StubLoggerService } from '../../../__tests__/_helpers/stubLoggerService.js'
import {
  isWorkbenchWindowVisible,
  TriggerSessionRevealService,
} from '../triggerSessionRevealService.js'

vi.mock('../../acp/session/revealSessionChat.js', () => ({
  revealSessionChat: vi.fn(),
}))

/** Drives the visibility seam directly: node tests have no workbench document. */
class TestRevealService extends TriggerSessionRevealService {
  visible = true

  protected override isWindowVisible(): boolean {
    return this.visible
  }
}

interface Harness {
  readonly service: TestRevealService
  readonly getById: ReturnType<typeof vi.fn>
  readonly deps: {
    readonly groups: IEditorGroupsService
    readonly inst: IInstantiationService
    readonly widgets: IAcpChatWidgetService
    readonly windowFocus: IWindowFocusService
  }
}

function makeHarness(): Harness {
  const session = { id: 'local-1', agentId: 'claude-code' } as unknown as IAcpSession
  const getById = vi.fn((id: string) => (id === 'agent-1' ? session : undefined))
  const deps = {
    groups: {} as IEditorGroupsService,
    inst: {} as IInstantiationService,
    widgets: {} as IAcpChatWidgetService,
    windowFocus: {} as IWindowFocusService,
  }
  const service = new TestRevealService(
    { getById } as unknown as IAcpSessionService,
    deps.groups,
    deps.inst,
    deps.widgets,
    deps.windowFocus,
    new StubLoggerService(),
  )
  return { service, getById, deps }
}

describe('isWorkbenchWindowVisible', () => {
  it('treats hidden and missing documents as not visible', () => {
    expect(isWorkbenchWindowVisible(undefined)).toBe(false)
    expect(isWorkbenchWindowVisible({ visibilityState: 'hidden' } as unknown as Document)).toBe(
      false,
    )
  })

  it('treats a visible document as visible', () => {
    expect(isWorkbenchWindowVisible({ visibilityState: 'visible' } as unknown as Document)).toBe(
      true,
    )
  })
})

describe('TriggerSessionRevealService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not reveal when the trigger did not set showSession', () => {
    const h = makeHarness()
    h.service.revealOnRunStart('agent-1', false)
    expect(revealSessionChat).not.toHaveBeenCalled()
  })

  it('reveals with the live local session id in a visible window', () => {
    const h = makeHarness()
    h.service.revealOnRunStart('agent-1', true)
    expect(revealSessionChat).toHaveBeenCalledWith(expect.objectContaining(h.deps), 'local-1', {
      agentId: 'claude-code',
    })
  })

  it('does not reveal in a hidden or minimized window', () => {
    const h = makeHarness()
    h.service.visible = false
    h.service.revealOnRunStart('agent-1', true)
    expect(revealSessionChat).not.toHaveBeenCalled()
  })

  it('falls back to the durable id when no live session can be resolved', () => {
    const h = makeHarness()
    h.getById.mockReturnValue(undefined)
    h.service.revealOnRunStart('missing', true)
    expect(revealSessionChat).toHaveBeenCalledWith(expect.anything(), 'missing', undefined)
  })
})
