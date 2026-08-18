import {
  Disposable,
  ILayoutService,
  IOutputService,
  IViewsService,
  IWindowsService,
  LogLevel,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  ILogFilesService,
  type LogAppendEvent,
  type LogFileDescriptor,
} from '../../shared/ipc/services.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'

const LOG_READ_MAX_BYTES = 1024 * 1024

export class ErrorLogAutoRevealContribution extends Disposable implements IWorkbenchContribution {
  private readonly _descriptorsByChannelId = new Map<string, LogFileDescriptor>()
  private _refreshing: Promise<void> | undefined
  private _hasRevealed = false
  /** The first error waiting to be revealed once this window becomes the top window. */
  private _pending: LogAppendEvent | undefined
  private _revealInProgress = false
  /** A focus event raced an in-flight top-window check; re-run once it settles. */
  private _retryAfterReveal = false
  private _myWindowId: number | undefined
  private _myWindowIdPromise: Promise<number> | undefined

  constructor(
    @ILogFilesService private readonly _logFiles: ILogFilesService,
    @IOutputService private readonly _output: IOutputService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
    @IWindowsService private readonly _windows: IWindowsService,
  ) {
    super()
    void this._refreshDescriptors()
    this._register(this._logFiles.onDidAppendEntry((event) => this._handleAppend(event)))
    this._register(this._windows.onDidChangeFocusedWindow((id) => this._handleFocusedWindow(id)))
  }

  private _handleAppend(event: LogAppendEvent): void {
    if (this._hasRevealed || this._pending) return
    if (event.maxLevel < LogLevel.Error) return
    // A persisted output channel is still being restored; don't steal the
    // active channel out from under the restore. Once the restore settles
    // (or there was none) errors auto-reveal as usual.
    if (this._output.hasPendingRestoredChannel) return

    this._pending = event
    void this._maybeReveal()
  }

  private _handleFocusedWindow(id: number): void {
    if (this._hasRevealed || this._pending === undefined) return
    if (this._myWindowId !== undefined && id !== this._myWindowId) return
    void this._maybeReveal()
  }

  private _maybeReveal(): Promise<void> {
    if (this._hasRevealed || this._pending === undefined) return Promise.resolve()
    if (this._revealInProgress) {
      this._retryAfterReveal = true
      return Promise.resolve()
    }
    this._retryAfterReveal = false
    this._revealInProgress = true
    return this._runReveal().finally(() => {
      this._revealInProgress = false
      if (this._retryAfterReveal) void this._maybeReveal()
    })
  }

  private async _runReveal(): Promise<void> {
    const event = this._pending
    if (!event) return
    const [topId, myId] = await Promise.all([
      this._windows.getFocusedWindowId(),
      this._getMyWindowId(),
    ])
    // Not the top window — stay pending and wait for the focus event.
    if (topId !== myId) return

    const didReveal = await this._revealErrorChannel(event)
    // Cleared on failure too so a later append retries (previous behavior).
    this._pending = undefined
    if (didReveal) this._hasRevealed = true
  }

  private async _revealErrorChannel(event: LogAppendEvent): Promise<boolean> {
    const descriptor = await this._findDescriptor(event.channelId)
    if (!descriptor) return false

    const channel = this._output.createChannel(descriptor.name, 'log')
    try {
      const content = await this._logFiles.readLogFile(descriptor.id, LOG_READ_MAX_BYTES)
      channel.clear()
      channel.append(content)
    } catch {
      if (!channel.hasContent.get()) channel.append(event.chunk)
    }

    this._output.setActiveChannel(descriptor.name)
    revealOutputPanel(this._layout, this._views)
    return true
  }

  private _getMyWindowId(): Promise<number> {
    if (!this._myWindowIdPromise) {
      this._myWindowIdPromise = this._windows.getCurrentWindowId().then((id) => {
        this._myWindowId = id
        return id
      })
    }
    return this._myWindowIdPromise
  }

  private async _findDescriptor(channelId: string): Promise<LogFileDescriptor | undefined> {
    let descriptor = this._descriptorsByChannelId.get(channelId)
    if (descriptor) return descriptor

    await this._refreshDescriptors()
    descriptor = this._descriptorsByChannelId.get(channelId)
    if (descriptor) return descriptor

    await this._refreshDescriptors()
    return this._descriptorsByChannelId.get(channelId)
  }

  private async _refreshDescriptors(): Promise<void> {
    if (this._refreshing) return this._refreshing

    const refreshing = this._logFiles
      .listLogFiles()
      .then((descriptors) => {
        this._descriptorsByChannelId.clear()
        for (const descriptor of descriptors) {
          this._descriptorsByChannelId.set(descriptor.channelId, descriptor)
        }
      })
      .catch(() => {})
      .finally(() => {
        this._refreshing = undefined
      })

    this._refreshing = refreshing
    return refreshing
  }
}
