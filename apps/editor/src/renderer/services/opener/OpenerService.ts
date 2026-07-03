/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenerService — the single entry point for "open this target" (VSCode parity,
 *  see packages/platform IOpenerService). A target is a web address, a file URI
 *  (with an optional `#L{line},{col}` selection), or a `command:` URI. Registered
 *  openers run newest-first; the first to report it handled the target wins.
 *
 *  Three built-in openers are registered here:
 *    - external : http/https/mailto → window.open (main's setWindowOpenHandler
 *                 forwards it to the OS browser and denies everything else)
 *    - command  : command:<id>?<json-args> → ICommandService, gated by
 *                 options.allowCommands (default: blocked) so untrusted content
 *                 — e.g. AI output — can never run arbitrary commands
 *    - file     : any file URI → reveal in an editor at the encoded selection,
 *                 routing directories to a new window and images to the resolver
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  extractSelection,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IFileService,
  IInstantiationService,
  ILoggerService,
  InstantiationType,
  IOpener,
  IOpenerOptions,
  IOpenerService,
  IUriIdentityService,
  IWindowsService,
  registerSingleton,
  toDisposable,
  URI,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../editor/openInLockAwareGroup.js'
import { findExistingFileEditor, revealSelectionInInput } from '../editor/revealEditorPosition.js'
import { splitFilePathLocation } from '../acp/filePathLink.js'

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto'])

export class OpenerService extends Disposable implements IOpenerService {
  declare readonly _serviceBrand: undefined

  private readonly _openers: IOpener[] = []
  private readonly _logger: ILogger

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'opener', name: 'Opener' })

    // Built-in openers, registered so the file opener (catch-all) runs last.
    // Parent their unregister-disposables to this service's store so they aren't
    // reported as leaks (they live for the service's lifetime).
    this._register(this.registerOpener(instantiation.createInstance(FileOpener)))
    this._register(this.registerOpener(instantiation.createInstance(CommandOpener)))
    this._register(this.registerOpener(new ExternalOpener()))
  }

  registerOpener(opener: IOpener): IDisposable {
    this._openers.unshift(opener) // newest-first
    return toDisposable(() => {
      const index = this._openers.indexOf(opener)
      if (index >= 0) this._openers.splice(index, 1)
    })
  }

  async open(target: URI | string, options?: IOpenerOptions): Promise<boolean> {
    const uri = typeof target === 'string' ? parseTarget(target) : target
    for (const opener of this._openers) {
      try {
        if (await opener.open(uri, options)) return true
      } catch (err) {
        this._logger.error(`opener failed for ${uri.toString()}: ${(err as Error).message}`)
      }
    }
    this._logger.warn(`no opener handled ${uri.toString()}`)
    return false
  }
}

/**
 * Turn a raw string into a URI. A bare filesystem path (no URL scheme) becomes a
 * `file:` URI, with any `:line:col` suffix folded into the selection fragment so
 * the file opener reveals that position.
 */
export function parseTarget(target: string): URI {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(?:mailto|command):/i.test(target)) {
    // Windows drive paths (`D:\…`) read as a scheme but are filesystem paths.
    if (!/^[A-Za-z]:[/\\]/.test(target)) return URI.parse(target)
  }
  const { path, line, col } = splitFilePathLocation(target)
  const uri = URI.file(path)
  return line !== undefined
    ? uri.with({ fragment: `${line}${col !== undefined ? `,${col}` : ''}` })
    : uri
}

class ExternalOpener implements IOpener {
  async open(target: URI): Promise<boolean> {
    if (!EXTERNAL_SCHEMES.has(target.scheme)) return false
    // Main's setWindowOpenHandler forwards http(s) to the OS browser via
    // shell.openExternal and denies anything else.
    window.open(target.toString(), '_blank')
    return true
  }
}

export class CommandOpener implements IOpener {
  constructor(@ICommandService private readonly _commands: ICommandService) {}

  async open(target: URI, options?: IOpenerOptions): Promise<boolean> {
    if (target.scheme !== 'command') return false

    const allow = options?.allowCommands
    // Default-deny: untrusted callers (no allowCommands) never run commands.
    if (!allow) return true
    const id = target.path
    if (Array.isArray(allow) && !allow.includes(id)) return true

    let args: unknown[] = []
    if (target.query) {
      try {
        const parsed: unknown = JSON.parse(decodeURIComponent(target.query))
        args = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // A non-JSON query is passed through as a single string argument.
        args = [target.query]
      }
    }
    await this._commands.executeCommand(id, ...args)
    return true
  }
}

class FileOpener implements IOpener {
  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IFileService private readonly _fileService: IFileService,
    @IWindowsService private readonly _windows: IWindowsService,
    @IEditorResolverService private readonly _resolver: IEditorResolverService,
  ) {}

  async open(target: URI): Promise<boolean> {
    if (target.scheme !== 'file') return false
    const { selection, uri } = extractSelection(target)

    // A directory can't be shown as an editor — open it in a new window (parity
    // with a dropped folder / the Monaco open handler).
    if (await this._isDirectory(uri)) {
      await this._windows.openWindow(uri)
      return true
    }

    // No selection: route through the resolver so specialized editors win — an
    // image opens in the image preview rather than as garbled binary text.
    if (!selection) {
      void this._resolver.openEditor(uri, { pinned: true })
      return true
    }

    // A selection targets the text source, which only a FileEditorInput can honor.
    const input = this._revealExistingOrOpen(uri)
    void revealSelectionInInput(input, selection)
    return true
  }

  private async _isDirectory(uri: URI): Promise<boolean> {
    try {
      return (await this._fileService.stat(uri)).isDirectory
    } catch {
      return false
    }
  }

  private _revealExistingOrOpen(uri: URI): FileEditorInput {
    const existing = findExistingFileEditor(this._groups, this._uriIdentity, uri)
    if (existing) {
      this._groups.activateGroup(existing.group)
      existing.group.setActive(existing.editor)
      return existing.editor
    }
    const input = this._instantiation.createInstance(FileEditorInput, uri)
    openInLockAwareGroup(this._groups, input, { activate: true, pinned: true })
    return input
  }
}

registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed)
