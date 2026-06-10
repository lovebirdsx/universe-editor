/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  GitBlameContribution — VSCode-style inline git blame. For the active file
 *  editor it shows, at the end of the cursor's line, a dimmed annotation
 *  "${subject}, ${author} (${time ago})", mirrors it in the status bar, and
 *  serves a hover with the full commit info. Blame data comes from the `git`
 *  extension's `git.getBlame` contributed command; all rendering happens here
 *  because the extension API has no editor-decoration surface.
 *
 *  Only the line(s) under a cursor are annotated (matching VSCode's built-in
 *  blame), so we never blame the whole file. Data is cached per file path and
 *  invalidated when the model content changes.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  DisposableStore,
  ICommandService,
  IConfigurationService,
  IEditorService,
  IStatusBarService,
  StatusBarAlignment,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
  autorun,
} from '@universe-editor/platform'
import { BlameCommands, type BlameResultDto } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'

const OPEN_COMMIT_COMMAND = 'gitblame.openCommit'
const DEFAULT_TEMPLATE = '${subject}, ${authorName} (${authorDateAgo})'
const DEFAULT_STATUSBAR_TEMPLATE = '${authorName} (${authorDateAgo})'

interface ResolvedLineBlame {
  /** Rendered annotation text for the inline editor decoration. */
  decorationText: string
  /** Rendered annotation text for the status bar item. */
  statusBarText: string
  /** Commit hash, or undefined for not-yet-committed lines. */
  hash?: string
  /** Markdown lines for the hover, or undefined when there is no commit. */
  hover?: string
}

function fromNow(date: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - date) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.round(months / 12)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

function applyTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, token: string) =>
    Object.prototype.hasOwnProperty.call(tokens, token) ? (tokens[token] ?? '') : whole,
  )
}

export class GitBlameContribution extends Disposable implements IWorkbenchContribution {
  private _entry: IStatusBarEntryAccessor | undefined
  private _decorations: monaco.editor.IEditorDecorationsCollection | undefined
  private readonly _editorStore = this._register(new DisposableStore())
  private readonly _registryStore = this._register(new DisposableStore())

  /** Blame result per absolute file path; cleared on content change. */
  private readonly _cache = new Map<string, BlameResultDto | null>()
  private readonly _inflight = new Map<string, Promise<BlameResultDto | null>>()

  private _activePath: string | undefined
  private _currentHash: string | undefined

  constructor(
    @IEditorService editorService: IEditorService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
    @ICommandService private readonly _commandService: ICommandService,
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
  ) {
    super()

    this._register(
      CommandsRegistry.registerCommand(OPEN_COMMIT_COMMAND, () => {
        if (this._currentHash) void this._commandService.executeCommand('git-graph.view')
      }),
    )

    this._register(
      autorun((r) => {
        const active = editorService.activeEditor.read(r)
        if (active instanceof FileEditorInput) {
          this._bind(active)
        } else {
          this._clear()
        }
      }),
    )

    this._register(
      this._configurationService.onDidChangeConfiguration((e) => {
        // The whitespace setting changes the blame result itself, so drop the cache.
        if (e.affectsConfiguration('git.blame.ignoreWhitespace')) this._cache.clear()
        if (this._activeEditor) this._refresh()
      }),
    )

    void MonacoLoader.ensureInitialized().then(() => {
      if (this._store.isDisposed) return
      this._register(
        languageFeatures.registerHoverProvider('*', {
          provideHover: (model, position) => this._provideHover(model, position),
        }),
      )
    })

    this._register({ dispose: () => this._clear() })
  }

  private _activeEditor: monaco.editor.IStandaloneCodeEditor | undefined

  private get _decorationsEnabled(): boolean {
    return this._configurationService.get('git.blame.editorDecoration.enabled', true) ?? true
  }

  private get _statusBarEnabled(): boolean {
    return this._configurationService.get('git.blame.statusBarItem.enabled', true) ?? true
  }

  private get _hoverEnabled(): boolean {
    return !(
      this._configurationService.get('git.blame.editorDecoration.disableHover', false) ?? false
    )
  }

  private get _ignoreWhitespace(): boolean {
    return this._configurationService.get('git.blame.ignoreWhitespace', false) ?? false
  }

  private _bind(input: FileEditorInput): void {
    this._activePath = input.resource.fsPath
    this._editorStore.clear()
    this._registryStore.clear()

    const attach = (): void => {
      this._editorStore.clear()
      const editor = FileEditorRegistry.get(input)
      this._activeEditor = editor
      this._decorations = editor?.createDecorationsCollection()
      if (!editor) return

      this._editorStore.add(editor.onDidChangeCursorPosition(() => this._refresh()))
      const model = editor.getModel()
      if (model) {
        this._editorStore.add(
          model.onDidChangeContent(() => {
            this._cache.delete(this._activePath ?? '')
            this._refresh()
          }),
        )
      }
      this._refresh()
    }

    attach()
    this._registryStore.add(
      FileEditorRegistry.onDidChange((changed) => {
        if (changed === input) attach()
      }),
    )
  }

  private _refresh(): void {
    const editor = this._activeEditor
    const path = this._activePath
    if (!editor || !path) return

    const position = editor.getPosition()
    if (!position) {
      this._render(undefined)
      return
    }
    const line = position.lineNumber

    void this._getBlame(path).then((result) => {
      // Bail if the editor/cursor moved on while we were fetching.
      if (this._activeEditor !== editor || editor.getPosition()?.lineNumber !== line) return
      this._render(result ? this._resolveLine(result, line) : undefined)
    })
  }

  private _getBlame(path: string): Promise<BlameResultDto | null> {
    if (this._cache.has(path)) return Promise.resolve(this._cache.get(path) ?? null)
    const existing = this._inflight.get(path)
    if (existing) return existing

    const p = this._commandService
      .executeCommand<BlameResultDto | null>(BlameCommands.getBlame, path, this._ignoreWhitespace)
      .then((r) => {
        this._inflight.delete(path)
        // `undefined` means the command isn't registered yet (extension host still
        // activating) — don't cache it so a later cursor move retries. `null` is a
        // real "no blame for this file" answer and is cached.
        if (r === undefined) return null
        this._cache.set(path, r)
        return r
      })
      .catch(() => {
        this._inflight.delete(path)
        return null
      })
    this._inflight.set(path, p)
    return p
  }

  private _resolveLine(result: BlameResultDto, line: number): ResolvedLineBlame | undefined {
    if (result.uncommittedLines.includes(line)) {
      return { decorationText: 'Not Committed Yet', statusBarText: 'Not Committed Yet' }
    }
    const commit = result.commits.find((c) =>
      c.ranges.some((range) => line >= range.startLine && line <= range.endLine),
    )
    if (!commit) return undefined

    const ago = fromNow(commit.authorDate)
    const tokens = {
      hash: commit.hash,
      hashShort: commit.hash.slice(0, 8),
      subject: commit.summary,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authorDate: new Date(commit.authorDate).toLocaleString(),
      authorDateAgo: ago,
    }
    const decorationTemplate =
      this._configurationService.get('git.blame.editorDecoration.template', DEFAULT_TEMPLATE) ??
      DEFAULT_TEMPLATE
    const statusBarTemplate =
      this._configurationService.get(
        'git.blame.statusBarItem.template',
        DEFAULT_STATUSBAR_TEMPLATE,
      ) ?? DEFAULT_STATUSBAR_TEMPLATE
    const hover = [
      `**${commit.authorName}** <${commit.authorEmail}>`,
      '',
      commit.summary,
      '',
      `${new Date(commit.authorDate).toLocaleString()} (${ago})`,
      '',
      `\`${commit.hash.slice(0, 8)}\``,
    ].join('\n')
    return {
      decorationText: applyTemplate(decorationTemplate, tokens),
      statusBarText: applyTemplate(statusBarTemplate, tokens),
      hash: commit.hash,
      hover,
    }
  }

  private _render(blame: ResolvedLineBlame | undefined): void {
    this._currentHash = blame?.hash
    this._renderDecoration(blame)
    this._renderStatusBar(blame)
  }

  private _renderDecoration(blame: ResolvedLineBlame | undefined): void {
    const editor = this._activeEditor
    const collection = this._decorations
    if (!editor || !collection) return
    if (!blame || !this._decorationsEnabled) {
      collection.clear()
      this._setBlameContent(undefined)
      return
    }
    const position = editor.getPosition()
    if (!position) {
      collection.clear()
      this._setBlameContent(undefined)
      return
    }
    const line = position.lineNumber
    const m = MonacoLoader.get()
    // The annotation is painted by a CSS ::after pseudo-element (see
    // .git-blame-inline-decoration in workbench.css) fed via a custom property,
    // not Monaco injected text: injected text counts as real content and wraps
    // when word-wrap is on, whereas a pseudo-element never does.
    this._setBlameContent(`   ${blame.decorationText}`)
    collection.set([
      {
        range: new m.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
        options: {
          afterContentClassName: 'git-blame-inline-decoration',
          showIfCollapsed: true,
        },
      },
    ])
  }

  private _setBlameContent(text: string | undefined): void {
    const node = this._activeEditor?.getContainerDomNode()
    if (!node) return
    if (text === undefined) {
      node.style.removeProperty('--git-blame-content')
      return
    }
    // CSS string literal: escape backslash and double-quote, drop newlines.
    const escaped = text.replace(/[\\"]/g, (c) => '\\' + c).replace(/\r?\n/g, ' ')
    node.style.setProperty('--git-blame-content', `"${escaped}"`)
  }

  private _renderStatusBar(blame: ResolvedLineBlame | undefined): void {
    if (!blame || !this._statusBarEnabled) {
      this._entry?.dispose()
      this._entry = undefined
      return
    }
    const entry = {
      text: blame.statusBarText,
      tooltip: 'Git Blame',
      alignment: StatusBarAlignment.Right,
      priority: 95,
      ...(blame.hash ? { command: OPEN_COMMIT_COMMAND } : {}),
    }
    if (this._entry) {
      this._entry.update(entry)
    } else {
      this._entry = this._statusBarService.addEntry(entry)
    }
  }

  private _provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): monaco.languages.ProviderResult<monaco.languages.Hover> {
    const editor = this._activeEditor
    if (!editor || editor.getModel() !== model) return null
    if (!this._hoverEnabled) return null
    if (position.lineNumber !== editor.getPosition()?.lineNumber) return null
    // Only show on the (virtual) end of the line, where the annotation sits.
    if (position.column < model.getLineMaxColumn(position.lineNumber)) return null

    const path = this._activePath
    const cached = path ? this._cache.get(path) : null
    if (!cached) return null
    const resolved = this._resolveLine(cached, position.lineNumber)
    if (!resolved?.hover) return null
    return { contents: [{ value: resolved.hover, isTrusted: true }] }
  }

  private _clear(): void {
    this._editorStore.clear()
    this._registryStore.clear()
    this._decorations?.clear()
    this._decorations = undefined
    this._setBlameContent(undefined)
    this._entry?.dispose()
    this._entry = undefined
    this._activeEditor = undefined
    this._activePath = undefined
    this._currentHash = undefined
  }
}
