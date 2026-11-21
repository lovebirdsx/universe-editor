/*---------------------------------------------------------------------------------------------
 *  TrustedViewEditorInput — an editor tab backed by a `contributes.trustedViews`
 *  entry with `location: 'editor'`. The component itself is mounted by
 *  TrustedViewEditor / TrustedViewHost; this input only carries identity, state
 *  and the tab label so the tab survives a window restore.
 *
 *  Identity includes the renderer key (`viewId` + key), so two tabs of the same
 *  view with different keys coexist while `openTrustedEditor(..., { key })`
 *  focuses the existing one.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export interface ITrustedViewEditorInputOptions {
  readonly extensionId: string
  readonly viewId: string
  /** Stable per-tab identity, generated when the opener supplied none. */
  readonly key: string
  readonly title?: string
  readonly state?: unknown
}

interface ISerializedTrustedViewEditor {
  readonly extensionId: string
  readonly viewId: string
  readonly title?: string
  readonly state?: unknown
  readonly key: string
}

export class TrustedViewEditorInput extends EditorInput {
  static readonly TYPE_ID = 'trustedView'

  readonly extensionId: string
  readonly viewId: string
  readonly key: string
  readonly state: unknown

  private readonly _resource: URI
  private readonly _title: string | undefined
  private _titleOverride: string | undefined
  private _contributionName: string | undefined

  constructor(options: ITrustedViewEditorInputOptions) {
    super()
    this.extensionId = options.extensionId
    this.viewId = options.viewId
    this.key = options.key
    this.state = options.state
    this._title = options.title
    this._resource = URI.from({
      scheme: 'trusted-view',
      path: `/${options.viewId}`,
      query: `key=${encodeURIComponent(options.key)}`,
    })
  }

  override get typeId(): string {
    return TrustedViewEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override get id(): string {
    return `trustedView:${this.extensionId}:${this.viewId}:${this.key}`
  }

  override getName(): string {
    return this._titleOverride ?? this._title ?? this._contributionName ?? this.viewId
  }

  /** `ctx.setTitle`: update the tab label (and what gets persisted on restore). */
  setTitle(title: string): void {
    const next = title.trim()
    if (!next || next === this._titleOverride) return
    this._titleOverride = next
    this._onDidChangeLabel.fire()
  }

  /** Use the manifest name until the component (or opener) supplies a title. */
  setContributionName(name: string): void {
    if (name === this._contributionName) return
    const before = this.getName()
    this._contributionName = name
    if (this.getName() !== before) this._onDidChangeLabel.fire()
  }

  override serialize(): ISerializedTrustedViewEditor {
    return {
      extensionId: this.extensionId,
      viewId: this.viewId,
      key: this.key,
      ...(this._titleOverride !== undefined ? { title: this._titleOverride } : {}),
      state: this.state,
    }
  }

  static deserialize(data: unknown): TrustedViewEditorInput | null {
    if (typeof data !== 'object' || data === null) return null
    const d = data as Partial<Record<keyof ISerializedTrustedViewEditor, unknown>>
    if (
      typeof d.extensionId !== 'string' ||
      typeof d.viewId !== 'string' ||
      typeof d.key !== 'string' ||
      d.extensionId.length === 0 ||
      d.viewId.length === 0 ||
      d.key.length === 0
    ) {
      return null
    }
    return new TrustedViewEditorInput({
      extensionId: d.extensionId,
      viewId: d.viewId,
      key: d.key,
      ...(typeof d.title === 'string' ? { title: d.title } : {}),
      ...('state' in d ? { state: d.state } : {}),
    })
  }
}
