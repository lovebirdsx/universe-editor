/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: the editor tab right-click menu must keep gating file commands on
 *  the clicked tab across re-renders under React StrictMode. The scoped
 *  ContextKeyService that carries `resourceScheme` must not be disposed (which
 *  clears its keys) by StrictMode's effect-cleanup dry-run, otherwise a later
 *  re-render re-evaluates `when: resourceScheme == file` against an emptied
 *  context and every file command (Copy Name/Path, Reveal, Reopen With…)
 *  vanishes, leaving only the unconditional Close group.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode, useRef, useState } from 'react'
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type ICommandService as ICommandServiceType,
} from '@universe-editor/platform'
import { EditorTabContextMenu } from '../EditorTabContextMenu.js'
import { ServicesContext } from '../../useService.js'
import {
  CopyEditorNameAction,
  CopyFilePathAction,
  CopyFileRelativePathAction,
} from '../../../actions/fileCopyActions.js'
import { RevealInExplorerAction, RevealInOSExplorerAction } from '../../../actions/revealActions.js'

const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

const disposables: IDisposable[] = []

afterEach(() => {
  cleanup()
  while (disposables.length) disposables.pop()!.dispose()
})

function register(): void {
  disposables.push(
    registerAction2(CopyEditorNameAction),
    registerAction2(CopyFilePathAction),
    registerAction2(CopyFileRelativePathAction),
    registerAction2(RevealInExplorerAction),
    registerAction2(RevealInOSExplorerAction),
  )
}

// Wraps the menu with a button that forces a parent re-render, mirroring the
// real app where EditorGroupView re-renders (fresh `args`/`onClose` each render)
// after the menu has mounted.
function Harness() {
  const [, force] = useState(0)
  const instRef = useRef<{ inst: InstantiationService; ctx: ContextKeyService } | null>(null)
  if (!instRef.current) {
    const contextKeyService = new ContextKeyService()
    const services = new ServiceCollection()
    services.set(ICommandService, stubCommand)
    services.set(IContextKeyService, contextKeyService)
    instRef.current = { inst: new InstantiationService(services), ctx: contextKeyService }
  }
  const { inst, ctx } = instRef.current
  return (
    <ServicesContext.Provider value={inst}>
      <button data-testid="rerender" onClick={() => force((n) => n + 1)}>
        rerender
      </button>
      <EditorTabContextMenu
        x={10}
        y={10}
        groupId={1}
        editorId="editor-1"
        editorType="file"
        resource={URI.file('D:/foo.txt')}
        commandService={stubCommand}
        contextKeyService={ctx}
        onClose={() => {}}
      />
    </ServicesContext.Provider>
  )
}

describe('EditorTabContextMenu — file commands survive re-render under StrictMode', () => {
  it('keeps the file commands after a parent re-render', async () => {
    register()
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
    expect(await screen.findByText('Copy Name')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('rerender'))
    })

    expect(screen.getByText('Copy Name')).toBeTruthy()
    expect(screen.getByText('Copy Path')).toBeTruthy()
    expect(screen.getByText('Reveal in Explorer View')).toBeTruthy()
  })
})
