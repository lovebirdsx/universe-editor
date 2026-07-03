/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IOpenerService (platform/opener/common/opener.ts).
 *
 *  A single entry point for "open this target" — a web address, a file URI (with
 *  an optional line/column encoded in the fragment), or a `command:` URI. The
 *  service delegates to registered openers in newest-first order; the first that
 *  reports it handled the target wins. The concrete openers (external / command /
 *  file) live in the renderer, since locating a position needs the editor stack.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../base/lifecycle.js'
import { URI } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

/** A text selection, 1-based (matching Monaco's line/column convention). */
export interface ITextEditorSelection {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber?: number
  readonly endColumn?: number
}

export interface IOpenerOptions {
  /** Open the editor to the side of the currently active one. */
  readonly openToSide?: boolean
  /**
   * Allow `command:` URIs to run. `true` permits any command; an array is a
   * whitelist of allowed command ids; falsy (the default) blocks all commands.
   * Mirrors VSCode's markdown `isTrusted` gate — untrusted content (e.g. AI
   * output) must never execute arbitrary commands.
   */
  readonly allowCommands?: boolean | readonly string[]
  /** The open was triggered by a user gesture (click/keyboard) rather than API. */
  readonly fromUserGesture?: boolean
}

export interface IOpener {
  /** Return `true` when this opener handled the target, `false` to pass it on. */
  open(target: URI | string, options?: IOpenerOptions): Promise<boolean>
}

export interface IOpenerService {
  readonly _serviceBrand: undefined

  /** Register a participant that can handle open(). Newest-registered runs first. */
  registerOpener(opener: IOpener): IDisposable

  /**
   * Open a resource: a web address, a document URI (line/column encoded in the
   * fragment as `#L{line},{col}`), or a `command:` URI. Resolves to whether some
   * opener handled it.
   */
  open(target: URI | string, options?: IOpenerOptions): Promise<boolean>
}

export const IOpenerService = createDecorator<IOpenerService>('openerService')

/**
 * Encode a selection into the URI fragment as `startLine,startCol[-endLine[,endCol]]`
 * (1-based). Callers MUST run {@link extractSelection} to strip it again before
 * handing the URI to anything selection-unaware.
 */
export function withSelection(uri: URI, selection: ITextEditorSelection): URI {
  const end = selection.endLineNumber
    ? `-${selection.endLineNumber}${selection.endColumn ? `,${selection.endColumn}` : ''}`
    : ''
  return uri.with({ fragment: `${selection.startLineNumber},${selection.startColumn}${end}` })
}

/**
 * Pull a selection out of a URI fragment. Understands (1-based, `L` prefix optional):
 *   file.ts#73            file.ts#L73           file.ts#73,84
 *   file.ts#73-83         file.ts#L73,84-L83,52
 * Returns the parsed selection (if any) and the URI with the fragment stripped.
 */
export function extractSelection(uri: URI): {
  selection: ITextEditorSelection | undefined
  uri: URI
} {
  let selection: ITextEditorSelection | undefined
  const match = /^L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?/.exec(uri.fragment)
  if (match) {
    selection = {
      startLineNumber: parseInt(match[1]!, 10),
      startColumn: match[2] ? parseInt(match[2], 10) : 1,
      ...(match[3] ? { endLineNumber: parseInt(match[3], 10) } : {}),
      ...(match[3] ? { endColumn: match[4] ? parseInt(match[4], 10) : 1 } : {}),
    }
    uri = uri.with({ fragment: '' })
  }
  return { selection, uri }
}
