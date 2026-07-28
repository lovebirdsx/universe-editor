/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Source Control actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IScmService, type IScmSourceControlModel } from '../services/extensions/ScmService.js'
import { repoShortName } from '../workbench/scm/scmShared.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'

interface RepoPickItem extends IQuickPickItem {
  readonly sc: IScmSourceControlModel
}

export class SwitchScmRepoAction extends Action2 {
  static readonly ID = 'scm.switchRepo'

  constructor() {
    super({
      id: SwitchScmRepoAction.ID,
      title: localize2('action.scm.switchRepo.title', 'Switch Repository…'),
      category: localize2('command.category.scm', 'Source Control'),
      keybinding: { primary: 'ctrl+shift+alt+g' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const scm = accessor.get(IScmService)
    const quickInput = accessor.get(IQuickInputService)

    const sourceControls = scm.sourceControls.get()
    if (sourceControls.length < 2) return

    const currentRootUri = scmViewState.selectedRepo.get() ?? sourceControls[0]?.rootUri
    const pick = await quickInput.pick<RepoPickItem>(
      sourceControls.map((sc, index) => ({
        id: `scm.repo.${index}`,
        label: repoShortName(sc),
        ...(sc.rootUri !== undefined ? { description: sc.rootUri } : {}),
        ...(sc.rootUri === currentRootUri ? { iconId: 'check' } : {}),
        sc,
      })),
      {
        placeholder: localize('action.scm.switchRepo.placeholder', 'Select a repository'),
        matchOnDescription: true,
      },
    )
    if (!pick) return
    scmViewState.setSelectedRepo(pick.sc.rootUri)
  }
}
