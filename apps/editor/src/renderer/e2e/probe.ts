/*---------------------------------------------------------------------------------------------
 *  Renderer-side E2E probe installer.
 *
 *  Installed only when `window.__UNIVERSE_E2E_ENABLED__` is true (set by preload
 *  after main forwarded the `--enable-e2e-probe` argv flag). Exposes a minimal,
 *  read-mostly API on `window.__E2E__` so Playwright specs can drive the
 *  workbench through service interfaces rather than fragile DOM selectors.
 *--------------------------------------------------------------------------------------------*/

import {
  LifecyclePhase,
  StatusBarAlignment,
  URI,
  onUnexpectedError,
  type ICommandService,
  type IContextKeyService,
  type IEditorService,
  type ILayoutService,
  type ILifecycleService,
  type IStatusBarService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import {
  E2E_PROBE_ENABLED_KEY,
  E2E_PROBE_KEY,
  type E2ELifecyclePhase,
  type E2EProbe,
  type E2EStatusBarEntry,
} from '../../shared/e2e/contract.js'

export interface E2EProbeServices {
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly lifecycleService: ILifecycleService
  readonly editorService: IEditorService
  readonly statusBarService: IStatusBarService
  readonly workspaceService: IWorkspaceService
  readonly layoutService: ILayoutService
}

function phaseToName(phase: LifecyclePhase): E2ELifecyclePhase {
  switch (phase) {
    case LifecyclePhase.Starting:
      return 'Starting'
    case LifecyclePhase.Ready:
      return 'Ready'
    case LifecyclePhase.Restored:
      return 'Restored'
    case LifecyclePhase.Eventually:
      return 'Eventually'
    default:
      return 'Starting'
  }
}

export function installE2EProbeIfEnabled(services: E2EProbeServices): void {
  if (typeof window === 'undefined' || window[E2E_PROBE_ENABLED_KEY] !== true) return

  const probe: E2EProbe = {
    whenReady: () => services.lifecycleService.when(LifecyclePhase.Ready),
    whenRestored: () => services.lifecycleService.when(LifecyclePhase.Restored),
    getLifecyclePhase: () => phaseToName(services.lifecycleService.phase),
    getContextKey: (key) => services.contextKeyService.get(key),
    runCommand: (id, ...args) => services.commandService.executeCommand(id, ...args),
    getActiveEditorUri: () => services.editorService.activeEditorId.get(),
    getStatusBarEntries: (): E2EStatusBarEntry[] =>
      services.statusBarService.entries.get().map(({ id, entry }) => ({
        id: String(id),
        text: entry.text,
        alignment: entry.alignment === StatusBarAlignment.Right ? 'right' : 'left',
      })),
    openWorkspace: (fsPath) => services.workspaceService.openFolder(URI.file(fsPath)),
    getCurrentWorkspacePath: () => services.workspaceService.current?.folder.fsPath,
    getLayoutSizes: () => ({ ...services.layoutService.sizes.get() }),
    setLayoutSize: (key, value) => services.layoutService.setSize(key, value),
    flushLayoutSave: () => services.layoutService.save(),
    triggerError: (message = 'E2E triggerError') => {
      throw new Error(message)
    },
    triggerUnexpectedError: (message = 'E2E triggerUnexpectedError') => {
      onUnexpectedError(new Error(message))
    },
  }

  window[E2E_PROBE_KEY] = probe

  console.info('[E2E] probe installed')
}
