import { afterEach, describe, expect, it } from 'vitest'
import { MenuId, MenuRegistry, registerAction2, type IDisposable } from '@universe-editor/platform'
import { OpenExtensionDocsAction, ShowReleaseNotesAction } from '../helpActions.js'

function helpMenuEntry(commandId: string) {
  return MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu).find(
    (item) => 'command' in item && item.command === commandId,
  )
}

describe('helpActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers Show Release Notes in the Help menu', () => {
    disposables.push(registerAction2(ShowReleaseNotesAction))

    expect(helpMenuEntry(ShowReleaseNotesAction.ID)).toMatchObject({ group: '0_docs', order: 4 })
  })

  it('registers Extension Development in the Help menu ahead of Release Notes', () => {
    disposables.push(registerAction2(OpenExtensionDocsAction))

    expect(helpMenuEntry(OpenExtensionDocsAction.ID)).toMatchObject({
      group: '0_docs',
      order: 3,
    })
  })
})
