import { describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import {
  ToggleBlameEditorDecorationAction,
  ToggleBlameStatusBarItemAction,
} from '../scmBlameActions.js'

type ToggleAction = {
  new (): { run(accessor: never): void }
}

function expectToggle(Action: ToggleAction, key: string): void {
  const config = new ConfigurationService()
  const instantiationService = new InstantiationService(
    new ServiceCollection([IConfigurationService, config]),
  )
  try {
    const action = new Action()
    instantiationService.invokeFunction((accessor) => action.run(accessor as never))
    expect(config.get<boolean>(key)).toBe(false)
    instantiationService.invokeFunction((accessor) => action.run(accessor as never))
    expect(config.get<boolean>(key)).toBe(true)
  } finally {
    instantiationService.dispose()
  }
}

describe('scmBlameActions', () => {
  it('ToggleBlameEditorDecorationAction flips scm.blame.editorDecoration.enabled', () => {
    expect(ToggleBlameEditorDecorationAction.ID).toBe('scm.blame.toggleEditorDecoration')
    expectToggle(ToggleBlameEditorDecorationAction, 'scm.blame.editorDecoration.enabled')
  })

  it('ToggleBlameStatusBarItemAction flips scm.blame.statusBarItem.enabled', () => {
    expect(ToggleBlameStatusBarItemAction.ID).toBe('scm.blame.toggleStatusBarItem')
    expectToggle(ToggleBlameStatusBarItemAction, 'scm.blame.statusBarItem.enabled')
  })
})
