/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The AI commit-message bridge must surface the SCM view and explicitly target
 *  the commit input; otherwise a remembered tree focus would hide the streamed
 *  message it exists to show.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ILayoutService,
  InstantiationService,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { RevealScmAction } from '../commitMessageActions.js'

describe('RevealScmAction', () => {
  const disposables: IDisposable[] = []
  let focusView: ReturnType<typeof vi.fn>

  function setup(): void {
    disposables.push(registerAction2(RevealScmAction))
    focusView = vi.fn(async () => true)
  }

  async function run(): Promise<void> {
    const services = new ServiceCollection()
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      focusView,
    } as unknown as ILayoutService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await CommandsRegistry.getCommand(RevealScmAction.ID)!.handler(accessor)
    })
  }

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    scmViewState._resetForTests()
    vi.clearAllMocks()
  })

  it('asks for the commit input and focuses the SCM view', async () => {
    setup()

    await run()

    expect(scmViewState.getRevealRequest()).toMatchObject({
      fsPath: null,
      focusInput: true,
    })
    expect(focusView).toHaveBeenCalledWith('workbench.view.scm.main', { source: 'command' })
  })
})
