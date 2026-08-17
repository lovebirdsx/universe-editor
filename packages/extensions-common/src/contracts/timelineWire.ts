/**
 * Timeline wire contract shared by the three processes (mirrors VSCode's
 * MainThreadTimeline/ExtHostTimeline). The extension host owns the providers
 * (registered via `workspace.registerTimelineProvider`); it pushes registrations
 * and change events to the renderer over `mainThreadTimeline`, and the renderer
 * pulls pages of items back over `extHostTimeline`.
 *
 * Providers are keyed by host-allocated handles. Item `handle`s are the
 * VSCode-derived stable key `${source}|${id ?? timestamp}` so a row keeps its
 * identity across reloads.
 */

import type { UriComponents } from '@universe-editor/platform'
import type { ICommandDto } from './scmWire.js'

export interface ITimelineItemDto {
  /** Stable key: `${source}|${id ?? timestamp}`. */
  handle: string
  /** Owning provider id (e.g. `git-history`). */
  source: string
  id?: string
  label: string
  description?: string
  tooltip?: string
  /** Epoch milliseconds. */
  timestamp: number
  /** Codicon id (e.g. `git-commit`). */
  themeIcon?: string
  command?: ICommandDto
  contextValue?: string
}

export interface ITimelineOptionsDto {
  /** Page cursor returned by the previous page (provider-defined meaning). */
  cursor?: string
  /** Page size. Only the numeric form of VSCode's `limit` crosses the wire. */
  limit?: number
  resetCache?: boolean
}

export interface ITimelineDto {
  source: string
  items: ITimelineItemDto[]
  /** Present when more pages are available. */
  cursor?: string
}

/**
 * Renderer ← host: provider registrations and change events. The host's
 * ChannelClient calls these on the renderer's ChannelServer.
 */
export interface IMainThreadTimeline {
  $registerTimelineProvider(
    handle: number,
    id: string,
    label: string,
    scheme: string[],
  ): Promise<void>
  $unregisterTimelineProvider(handle: number): Promise<void>
  /**
   * A provider's data changed. `uri` set → only that resource's timeline is
   * stale; `reset` → drop every cached page for the provider.
   *
   * `uri` is a mid-argument optional: `null` crosses the wire (JSON turns a
   * trailing/mid `undefined` into `null`), so consumers must check `== null`.
   */
  $emitTimelineChangeEvent(handle: number, uri: UriComponents | null, reset: boolean): void
}

/**
 * Host ← renderer: page requests from the built-in timeline view. The
 * renderer's ChannelClient calls these on the host's ChannelServer.
 *
 * All URIs cross the wire as `UriComponents` (`$mid`), so the host-side codec
 * can translate `remote-ssh` ↔ `file` for remote workspaces (see
 * `remoteProtocol.ts`: DTO paths are always URIs). The host revives them before
 * handing a string to the extension provider.
 */
export interface IExtHostTimeline {
  $provideTimeline(
    handle: number,
    uri: UriComponents,
    options: ITimelineOptionsDto,
  ): Promise<ITimelineDto | undefined>
}
