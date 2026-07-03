/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: back/forward navigation to a built-in guide doc that is no longer
 *  open must re-create it in place of the current doc tab (single-tab trail),
 *  not open a fresh tab. Mirrors the markdown-preview branch in navigateTo.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorRegistry,
  IContextKeyService,
  IEditorGroupsService,
  IHistoryService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  UriIdentityService,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { GoBackAction } from '../historyActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { HistoryService } from '../../services/history/HistoryService.js'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'

function setup() {
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IContextKeyService, new ContextKeyService())
  const history = new HistoryService(new UriIdentityService('win32'))
  services.set(IHistoryService, history)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return { groups, history, inst }
}

async function runGoBack(inst: InstantiationService): Promise<void> {
  const cmd = CommandsRegistry.getCommand(GoBackAction.ID)
  if (!cmd) throw new Error('GoBack not registered')
  await inst.invokeFunction(async (accessor) => {
    await cmd.handler(accessor)
  })
}

describe('GoBack — built-in guide doc no longer open', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('re-creates the doc in place of the current doc tab (no new tab)', async () => {
    disposables.push(registerAction2(GoBackAction))
    // navigateTo rebuilds a closed doc via EditorRegistry.deserialize(typeId).
    disposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: DocEditorInput.TYPE_ID,
        componentKey: 'doc',
        deserialize: (data) => DocEditorInput.deserialize(data),
      }),
    )

    const { groups, history, inst } = setup()
    const group = groups.activeGroup

    // Trail: index doc → linked doc walked in place (index tab closed). Only the
    // second doc is open now — the exact state after in-place link navigation.
    history.record({
      resource: new DocEditorInput('index').resource,
      typeId: DocEditorInput.TYPE_ID,
      serialized: { docId: 'index' },
    })
    const current = new DocEditorInput('getting-started/interface-tour')
    group.openEditor(current, { activate: true, pinned: true })
    history.record({
      resource: current.resource,
      typeId: DocEditorInput.TYPE_ID,
      serialized: { docId: 'getting-started/interface-tour' },
    })
    expect(group.editors).toHaveLength(1)

    await runGoBack(inst)

    // The index doc is rebuilt into the current tab's slot: still one tab, now
    // showing the index doc — not a second tab piled on.
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBeInstanceOf(DocEditorInput)
    expect((group.activeEditor as DocEditorInput).docId).toBe('index')
  })
})
