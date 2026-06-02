import {
  Disposable,
  ILayoutService,
  IOutputService,
  IViewsService,
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
  private _revealInProgress = false

  constructor(
    @ILogFilesService private readonly _logFiles: ILogFilesService,
    @IOutputService private readonly _output: IOutputService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
  ) {
    super()
    void this._refreshDescriptors()
    this._register(this._logFiles.onDidAppendEntry((event) => this._handleAppend(event)))
  }

  private _handleAppend(event: LogAppendEvent): void {
    if (this._hasRevealed || this._revealInProgress) return
    if (event.maxLevel < LogLevel.Error) return

    this._revealInProgress = true
    void this._revealErrorChannel(event)
      .then((didReveal) => {
        if (didReveal) this._hasRevealed = true
      })
      .finally(() => {
        this._revealInProgress = false
      })
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
      if (channel.content.get() === '') channel.append(event.chunk)
    }

    this._output.setActiveChannel(descriptor.name)
    revealOutputPanel(this._layout, this._views)
    return true
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
