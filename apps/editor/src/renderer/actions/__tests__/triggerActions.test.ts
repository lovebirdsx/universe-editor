/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger report menu entries: the chat context menu (gated on
 *  the trigger automation of the session it was raised on) and the session tab
 *  context menu (gated on the tab's automation).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { MenuId, MenuRegistry, registerAction2, type IDisposable } from '@universe-editor/platform'
import { ViewTriggerReportAction } from '../triggerActions.js'

let registration: IDisposable | undefined

afterEach(() => {
  registration?.dispose()
  registration = undefined
})

function menuItem(menuId: MenuId) {
  return MenuRegistry.getMenuItems(menuId).find(
    (entry) => 'command' in entry && entry.command === ViewTriggerReportAction.ID,
  )
}

function whenOf(menuId: MenuId): string | undefined {
  const when = menuItem(menuId)?.when
  return typeof when === 'string' ? when : when?.serialize()
}

describe('ViewTriggerReportAction menu entries', () => {
  it('offers View Report on trigger-started chats and session tabs', () => {
    registration = registerAction2(ViewTriggerReportAction)

    expect(menuItem(MenuId.AcpChatContext)).toMatchObject({ group: '3_session', order: 6 })
    expect(whenOf(MenuId.AcpChatContext)).toBe('acpChatSessionAutomation')

    expect(menuItem(MenuId.EditorTabContext)).toMatchObject({ group: '1_session', order: 3 })
    const tabWhen = whenOf(MenuId.EditorTabContext) ?? ''
    expect(tabWhen).toContain("activeEditorType == 'acp.session'")
    expect(tabWhen).toContain('acpSessionHasAutomation')
  })
})
