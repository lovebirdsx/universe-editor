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
 *    - file     : any filesystem URI (`file:` / `remote-ssh:`) → reveal in an
 *                 editor at the encoded selection, routing directories to a new
 *                 window and images to the resolver; virtual schemes are rejected
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  expandHomeDir,
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
  ITextEditorSelection,
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
import type { OpenTarget } from '../editor/openTarget.js'
import {
  openExistingInputWithTarget,
  openFreshInputWithTarget,
  openUriWithTarget,
} from '../editor/openWithTarget.js'
import { findExistingFileEditor, revealSelectionInInput } from '../editor/revealEditorPosition.js'
import { splitFilePathLocation } from '../acp/filePathLink.js'
import { isFileSystemUri } from '../files/fileSystemScheme.js'
import { IAuxiliaryEditorWindowService } from '../windows/auxiliaryEditorWindowService.js'
import { IWindowFocusService } from '../windows/windowFocusService.js'

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto'])

export class OpenerService extends Disposable implements IOpenerService {
  declare readonly _serviceBrand: undefined

  private readonly _openers: IOpener[] = []
  private readonly _logger: ILogger
  private readonly _home: string | undefined

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'opener', name: 'Opener' })
    const ipc = typeof window !== 'undefined' ? window.ipc : undefined
    this._home = typeof ipc?.home === 'string' && ipc.home.length > 0 ? ipc.home : undefined

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
    const uri = typeof target === 'string' ? parseTarget(target, this._home) : target
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
export function parseTarget(target: string, homeDir?: string): URI {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(?:mailto|command):/i.test(target)) {
    // Windows drive paths (`D:\…`) read as a scheme but are filesystem paths.
    if (!/^[A-Za-z]:[/\\]/.test(target)) return URI.parse(target)
  }
  const { path, line, col, endLine } = splitFilePathLocation(target)
  const resolved = homeDir ? (expandHomeDir(path, homeDir) ?? path) : path
  const uri = URI.file(resolved)
  if (line === undefined) return uri
  const suffix = col !== undefined ? `,${col}` : endLine !== undefined ? `-${endLine}` : ''
  return uri.with({ fragment: `${line}${suffix}` })
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

export class FileOpener implements IOpener {
  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IFileService private readonly _fileService: IFileService,
    @IWindowsService private readonly _windows: IWindowsService,
    @IEditorResolverService private readonly _resolver: IEditorResolverService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @IAuxiliaryEditorWindowService private readonly _aux: IAuxiliaryEditorWindowService,
  ) {}

  async open(target: URI, options?: IOpenerOptions): Promise<boolean> {
    if (!isFileSystemUri(target)) return false
    const { selection, uri } = extractSelection(target)
    const openTarget: OpenTarget = options?.openInNewWindow
      ? 'newWindow'
      : options?.openToSide
        ? 'side'
        : 'default'

    // A directory can't be shown as an editor — open it in a new window (parity
    // with a dropped folder / the Monaco open handler).
    if (await this._isDirectory(uri)) {
      await this._windows.openWindow(uri)
      return true
    }

    const targets = {
      groups: this._groups,
      aux: this._aux,
      inst: this._instantiation,
      uriIdentity: this._uriIdentity,
      resolver: this._resolver,
    }

    // No selection: route through the resolver so specialized editors win — an
    // image opens in the image preview rather than as garbled binary text.
    if (!selection) {
      if (openTarget !== 'default') {
        const result = await openUriWithTarget(targets, uri, openTarget, { pinned: true })
        if (result.handled) return true
      }
      void this._resolver.openEditor(uri, { pinned: true })
      return true
    }

    // A selection targets the text source, which only a FileEditorInput can honor.
    if (openTarget !== 'default') {
      const handled = await this._openSelectionTargeted(uri, selection, openTarget, targets)
      if (handled) return true
    }
    const input = this._revealExistingOrOpen(uri)
    void revealSelectionInInput(input, selection)
    return true
  }

  private async _openSelectionTargeted(
    uri: URI,
    selection: ITextEditorSelection,
    target: Exclude<OpenTarget, 'default'>,
    targets: {
      groups: IEditorGroupsService
      aux: IAuxiliaryEditorWindowService
      inst: IInstantiationService
      uriIdentity: IUriIdentityService
      resolver: IEditorResolverService
    },
  ): Promise<boolean> {
    const existing =
      target === 'newWindow'
        ? findExistingFileEditor(this._groups, this._uriIdentity, uri)
        : undefined
    if (existing) {
      const result = await openExistingInputWithTarget(
        targets,
        existing.editor,
        existing.group,
        target,
        { pinned: true },
      )
      if (!result.handled) return false
      if (result.editor instanceof FileEditorInput) {
        void revealSelectionInInput(result.editor, selection)
      }
      return true
    }
    const input = this._instantiation.createInstance(FileEditorInput, uri)
    const result = await openFreshInputWithTarget(targets, input, target, { pinned: true })
    if (!result.handled) {
      if (!input.isDisposed) input.dispose()
      return false
    }
    if (result.editor instanceof FileEditorInput) {
      void revealSelectionInInput(result.editor, selection)
    }
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
      this._windowFocus.focusGroup(existing.group)
      return existing.editor
    }
    const input = this._instantiation.createInstance(FileEditorInput, uri)
    openInLockAwareGroup(this._groups, input, { activate: true, pinned: true })
    return input
  }
}

registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed)
