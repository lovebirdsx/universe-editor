/**
 * `IMainThreadTrustedViews`: the renderer's host-facing half of trusted views.
 *
 * The host announces providers / posts session events / asks to open editor
 * tabs. Every entry point revalidates against the translated registry — the
 * trust gate already ran at translation, so a view id absent here means "not
 * trusted / not declared / extension gone".
 */
import type { IEditorService } from '@universe-editor/platform'
import type {
  IMainThreadTrustedViews,
  ITrustedEditorOpenDto,
} from '@universe-editor/extensions-common'
import { TrustedViewEditorInput } from '../editor/TrustedViewEditorInput.js'
import type { ITrustedViewService } from './TrustedViewService.js'

export class MainThreadTrustedViews implements IMainThreadTrustedViews {
  constructor(
    private readonly _trustedViews: ITrustedViewService,
    private readonly _editorService: IEditorService,
  ) {}

  $registerProvider(extensionId: string, viewId: string): Promise<void> {
    const registration = this._trustedViews.getView(viewId)
    if (!registration) {
      // Declared but not translated yet: an untrusted extension activated before
      // the user granted trust announces its provider first. The host already
      // resolved ownership from the scanned manifest, so keep the announcement
      // and let registerView replay it after "Trust and Load".
      this._trustedViews.markProviderPending(extensionId, viewId)
      return Promise.resolve()
    }
    if (registration.extensionId !== extensionId) {
      return Promise.reject(
        new Error(
          `extension "${extensionId}" cannot provide trusted view "${viewId}" owned by "${registration.extensionId}"`,
        ),
      )
    }
    this._trustedViews.markProviderRegistered(viewId)
    return Promise.resolve()
  }

  $unregisterProvider(viewId: string): Promise<void> {
    this._trustedViews.markProviderUnregistered(viewId)
    return Promise.resolve()
  }

  $postEvent(sessionId: string, name: string, data: unknown): Promise<void> {
    this._trustedViews.postEvent(sessionId, name, data)
    return Promise.resolve()
  }

  async $openEditor(
    extensionId: string,
    viewId: string,
    options: ITrustedEditorOpenDto,
  ): Promise<void> {
    const registration = this._trustedViews.getView(viewId)
    if (!registration) {
      throw new Error(`trusted view "${viewId}" is not registered (untrusted or undeclared)`)
    }
    if (registration.extensionId !== extensionId) {
      throw new Error(`extension "${extensionId}" does not own trusted view "${viewId}"`)
    }
    if (registration.contribution.location !== 'editor') {
      throw new Error(`trusted view "${viewId}" is a sidebar view, not an editor`)
    }

    const input = new TrustedViewEditorInput({
      extensionId,
      viewId,
      // Same viewId + key dedupes through EditorInput identity; no key means a
      // fresh tab per request, so allocate an unrepeatable one.
      key: options.key ?? crypto.randomUUID(),
      ...(options.title !== null ? { title: options.title } : {}),
      ...(options.state !== null ? { state: options.state } : {}),
    })
    await this._editorService.openEditor(input, {
      activate: !options.preserveFocus,
      preserveFocus: options.preserveFocus,
      pinned: true,
    })
  }
}
