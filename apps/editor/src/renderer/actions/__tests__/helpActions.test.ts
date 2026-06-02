import { afterEach, describe, expect, it } from 'vitest'
import { MenuId, MenuRegistry, registerAction2, type IDisposable } from '@universe-editor/platform'
import { ShowReleaseNotesAction } from '../helpActions.js'

describe('helpActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers Show Release Notes in the Help menu', () => {
    disposables.push(registerAction2(ShowReleaseNotesAction))

    const entry = MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu).find(
      (item) => 'command' in item && item.command === ShowReleaseNotesAction.ID,
    )
    expect(entry).toMatchObject({ group: '0_docs', order: 3 })
  })
})
