/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression guard: an active ACP session editor must render the inline
 *  `MenuId.EditorTitle` navigation icons (new session in current editor + 4
 *  timeline moves), while secondary session actions stay behind `...`.
 *  Gated by `activeEditorType == 'acp.session'`. A non-ACP editor must not.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import {
  Action2,
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  registerAction2,
  ServiceCollection,
  URI,
  MenuId,
  observableValue,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import {
  ChatFindAction,
  FocusBottomAcpTimelineAction,
  FocusNextAcpTimelineItemAction,
  FocusPreviousAcpTimelineItemAction,
  FocusTopAcpTimelineAction,
  JumpToAcpPlanAction,
  NewAgentSessionInCurrentEditorAction,
  ShowAcpSessionChangesAction,
} from '../../../actions/agentActions.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import {
  IScmDecorationsService,
  scmPathKey,
  type IScmDecorationsService as IScmDecorationsServiceType,
} from '../../../services/scm/ScmDecorationsService.js'

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
  prompt: async () => undefined,
}

const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

function renderWithServices(
  node: React.ReactNode,
  opts?: { strict?: boolean; configure?: (services: ServiceCollection) => void },
) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  opts?.configure?.(services)
  const inst = new InstantiationService(services)
  const tree = <ServicesContext.Provider value={inst}>{node}</ServicesContext.Provider>
  return render(opts?.strict ? <StrictMode>{tree}</StrictMode> : tree)
}

class FakeEditor extends EditorInput {
  constructor(
    private readonly _name: string,
    private readonly _typeId: string,
  ) {
    super()
  }
  get typeId() {
    return this._typeId
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

function FakeComponent({ input }: { input: { label: string } }) {
  return <div data-testid="fake-editor">{input.label}</div>
}

const componentMap = new Map<string, React.ComponentType<{ input: { label: string } }>>([
  ['agents.session', FakeComponent],
  ['fake', FakeComponent],
  ['file', FakeComponent],
])

const NAV_COMMANDS_IN_ORDER = [
  NewAgentSessionInCurrentEditorAction.ID, // order 0
  FocusPreviousAcpTimelineItemAction.ID, // order 2
  FocusNextAcpTimelineItemAction.ID, // order 3
  FocusTopAcpTimelineAction.ID, // order 4
  FocusBottomAcpTimelineAction.ID, // order 5
]
const OVERFLOW_SESSION_COMMANDS = [
  ShowAcpSessionChangesAction.ID,
  ChatFindAction.ID,
  JumpToAcpPlanAction.ID,
]

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

function registerNavActions() {
  disposables.push(
    registerAction2(NewAgentSessionInCurrentEditorAction),
    registerAction2(JumpToAcpPlanAction),
    registerAction2(ShowAcpSessionChangesAction),
    registerAction2(ChatFindAction),
    registerAction2(FocusPreviousAcpTimelineItemAction),
    registerAction2(FocusNextAcpTimelineItemAction),
    registerAction2(FocusTopAcpTimelineAction),
    registerAction2(FocusBottomAcpTimelineAction),
  )
}

class OpenChangesTitleAction extends Action2 {
  static readonly ID = 'git.openChange'

  constructor() {
    super({
      id: OpenChangesTitleAction.ID,
      title: 'Open Changes',
      icon: 'compare-changes',
      menu: [
        {
          id: MenuId.EditorTitle,
          when: 'resourceScheme == file && scmActiveResourceHasChanges && !isInDiffEditor',
          group: 'navigation',
        },
      ],
    })
  }

  override run(): void {}
}

function scmDecorationsFor(resource: URI): IScmDecorationsServiceType {
  const snapshot = observableValue('testScmDecorations', {
    files: new Map([[scmPathKey(resource.fsPath), { color: '#e2c08d', letter: 'M' }]]),
    folders: new Map(),
  })
  return {
    _serviceBrand: undefined,
    decorations: snapshot,
    getFile: (uri) => snapshot.get().files.get(scmPathKey(uri.fsPath)),
    getFolder: (uri) => snapshot.get().folders.get(scmPathKey(uri.fsPath)),
  }
}

describe('EditorGroupView — EditorTitle nav icons for ACP session', () => {
  it('renders the inline navigation icons in order for an active acp.session editor', async () => {
    registerNavActions()
    const reg = EditorRegistry.registerEditorProvider({
      typeId: AcpSessionEditorInput.TYPE_ID,
      componentKey: 'agents.session',
    })
    disposables.push(reg)

    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('sess', AcpSessionEditorInput.TYPE_ID))

    const { container } = renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
    )

    // The scoped contextKey is set in a parent effect; wait for the first icon.
    await screen.findByTestId(`view-title-action-${NewAgentSessionInCurrentEditorAction.ID}`)

    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      expect(screen.getByTestId(`view-title-action-${cmd}`)).toBeTruthy()
    }

    const renderedOrder = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="view-title-action-"]'),
    ).map((el) => el.dataset['testid']!.replace('view-title-action-', ''))
    expect(renderedOrder).toEqual(NAV_COMMANDS_IN_ORDER)
    for (const cmd of OVERFLOW_SESSION_COMMANDS) {
      expect(screen.queryByTestId(`view-title-action-${cmd}`)).toBeNull()
    }
    expect(screen.getByTestId('editor-title-overflow')).toBeTruthy()
  })

  it('does not render the ACP nav icons for a non-acp editor', async () => {
    registerNavActions()
    const reg = EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' })
    disposables.push(reg)

    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('plain', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
    )

    // Editor body renders, proving the group mounted — but no ACP nav icons.
    await screen.findByTestId('fake-editor')
    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      expect(screen.queryByTestId(`view-title-action-${cmd}`)).toBeNull()
    }
  })

  it('renders Open Changes for a file with SCM changes', async () => {
    disposables.push(registerAction2(OpenChangesTitleAction))
    disposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: FileEditorInput.TYPE_ID,
        componentKey: 'file',
      }),
    )

    const svc = new EditorGroupsService()
    disposables.push(svc)
    const resource = URI.file('D:/repo/changed.ts')
    svc.activeGroup.openEditor(new FileEditorInput(resource, {} as never))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
      {
        configure: (services) => {
          services.set(IScmDecorationsService, scmDecorationsFor(resource))
        },
      },
    )

    await screen.findByTestId(`view-title-action-${OpenChangesTitleAction.ID}`)
  })

  // Regression for the dev-only bug: under React StrictMode the per-group scoped
  // ContextKeyService is disposed by the mount→unmount→mount dry run. If the hook
  // doesn't recreate it, `activeEditorType` is never set for an editor that
  // becomes active *after* mount (exactly how ACP sessions open), so the icons
  // silently never appear in `pnpm dev` while the production build works.
  it('shows the ACP nav icons under StrictMode when the session becomes active after mount', async () => {
    registerNavActions()
    disposables.push(
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )
    disposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: AcpSessionEditorInput.TYPE_ID,
        componentKey: 'agents.session',
      }),
    )

    const svc = new EditorGroupsService()
    disposables.push(svc)
    // Mount with a non-ACP editor active so the tab bar renders but no ACP icons.
    svc.activeGroup.openEditor(new FakeEditor('plain', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
      { strict: true },
    )

    await screen.findByTestId('fake-editor')
    expect(
      screen.queryByTestId(`view-title-action-${NewAgentSessionInCurrentEditorAction.ID}`),
    ).toBeNull()

    // The ACP session opens later and becomes active — this fires
    // onDidActiveEditorChange, which only updates activeEditorType if the hook's
    // subscription survived StrictMode against a live scoped service.
    await act(async () => {
      svc.activeGroup.openEditor(new FakeEditor('sess', AcpSessionEditorInput.TYPE_ID))
    })

    await screen.findByTestId(`view-title-action-${NewAgentSessionInCurrentEditorAction.ID}`)
    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      expect(screen.getByTestId(`view-title-action-${cmd}`)).toBeTruthy()
    }
  })
})
