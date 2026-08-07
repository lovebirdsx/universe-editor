/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ScmBlameContribution — VSCode-style inline blame. For the active file
 *  editor it shows, at the end of the cursor's line, a dimmed annotation
 *  "${subject}, ${author} (${time ago})", mirrors it in the status bar, and
 *  serves a hover with the full commit info. Blame data comes from the owning
 *  SCM provider's `<providerId>.getBlame` contributed command (git / perforce);
 *  all rendering happens here because the extension API has no editor-decoration
 *  surface. (Formerly GitBlameContribution — the .git-blame-* CSS hooks keep
 *  their historical names.)
 *
 *  Only the line(s) under a cursor are annotated (matching VSCode's built-in
 *  blame), so we never blame the whole file. Data is cached per provider+path
 *  slot and invalidated when the model content changes.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  DisposableStore,
  ICommandService,
  IConfigurationService,
  IEditorService,
  ILoggerService,
  IStatusBarService,
  StatusBarAlignment,
  ThrottledDelayer,
  type ILogger,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
  autorun,
  localize,
} from '@universe-editor/platform'
import { blameCommandId, type BlameResultDto } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { IScmService, resolveScmProviderId } from '../services/extensions/ScmService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'

const OPEN_COMMIT_COMMAND = 'scm.blame.openCommit'
const DEFAULT_TEMPLATE = '${subject}, ${authorName} (${authorDateAgo})'
const DEFAULT_STATUSBAR_TEMPLATE = '${authorName} (${authorDateAgo})'

/** Command that opens the provider's history graph at a commit. git/perforce
 *  have reveal bridges (`_workbench.*`); other providers fall back to the
 *  `<providerId>-graph.view` naming convention (no reveal argument). */
function openCommitGraphCommand(providerId: string): string {
  if (providerId === 'git') return '_workbench.openGitGraph'
  if (providerId === 'perforce') return '_workbench.openPerforceGraph'
  return `${providerId}-graph.view`
}
/**
 * Editing invalidates the blame cache, so an un-throttled refresh would rerun
 * `git blame` on every keystroke (typing fires content + cursor events as a
 * pair). Cache hits still render immediately; only a miss goes through this.
 */
const BLAME_DELAY_MS = 500

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

/** Cache key for blame results: provider-slotted so switching the SCM view's
 *  selected repo never serves the other provider's blame for the same path. */
function blameCacheKey(providerId: string | undefined, path: string): string {
  return `${providerId ?? ''}\n${path}`
}

export class ScmBlameContribution extends Disposable implements IWorkbenchContribution {
  private _entry: IStatusBarEntryAccessor | undefined
  private _decorations: monaco.editor.IEditorDecorationsCollection | undefined
  private readonly _editorStore = this._register(new DisposableStore())
  private readonly _registryStore = this._register(new DisposableStore())
  private readonly _blameDelayer = this._register(new ThrottledDelayer<void>(BLAME_DELAY_MS))
  private readonly _logger: ILogger

  /** Blame result per provider+path slot; cleared on content change. */
  private readonly _cache = new Map<string, BlameResultDto | null>()
  private readonly _inflight = new Map<string, Promise<BlameResultDto | null>>()

  private _activePath: string | undefined
  private _currentHash: string | undefined
  /** Provider the current status-bar entry was rendered from (drives its click target). */
  private _activeProviderId: string | undefined
  /** Generation of the latest `_refresh` call; stale in-flight fetches compare and drop. */
  private _refreshSeq = 0

  constructor(
    @IEditorService editorService: IEditorService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
    @ICommandService private readonly _commandService: ICommandService,
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
    @IScmService private readonly _scm: IScmService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'scmBlame', name: 'SCM Blame' })

    this._register(
      CommandsRegistry.registerCommand(OPEN_COMMIT_COMMAND, (_accessor, ...args) => {
        const [hash, providerId] = args as [string | undefined, string | undefined]
        return this._openCommit(hash, providerId)
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
        if (e.affectsConfiguration('scm.blame.ignoreWhitespace')) this._cache.clear()
        if (this._activeEditor) this._refresh()
      }),
    )

    // Switching the SCM view's selected repo re-arbitrates which provider's
    // blame shows for the active file; the old annotation stays until the new
    // provider's data resolves, and its cache slot survives for switching back.
    this._register(
      autorun((r) => {
        scmViewState.selectedRepo.read(r)
        if (this._activeEditor) this._refresh()
      }),
    )

    // Provider registration also re-arbitrates: at startup the restored
    // selectedRepo can point at a provider whose source control doesn't exist
    // yet (extensions activate one by one), so arbitration falls back to the
    // longest-prefix owner. Without this trigger the fallback blame would stick
    // until the user touched the caret or re-picked the repo.
    this._register(
      autorun((r) => {
        this._scm.sourceControls.read(r)
        if (this._activeEditor) this._refresh()
      }),
    )

    void MonacoLoader.ensureInitialized().then(async () => {
      if (this._store.isDisposed) return
      this._register(
        languageFeatures.registerHoverProvider('*', {
          provideHover: (model, position) => this._provideHover(model, position),
        }),
      )
      // Trusted-hover `command:` links dispatch through monaco's own command
      // registry — a separate registry from the platform one above.
      const { CommandsRegistry: monacoCommandsRegistry } =
        await import('monaco-editor/esm/vs/platform/commands/common/commands.js')
      if (this._store.isDisposed) return
      this._register(
        monacoCommandsRegistry.registerCommand(OPEN_COMMIT_COMMAND, (_accessor, ...args) => {
          const [hash, providerId] = args as [string | undefined, string | undefined]
          return this._openCommit(hash, providerId)
        }),
      )
    })

    this._register({ dispose: () => this._clear() })
  }

  private _activeEditor: monaco.editor.IStandaloneCodeEditor | undefined

  private get _decorationsEnabled(): boolean {
    return this._configurationService.get('scm.blame.editorDecoration.enabled', true) ?? true
  }

  private get _statusBarEnabled(): boolean {
    return this._configurationService.get('scm.blame.statusBarItem.enabled', true) ?? true
  }

  private get _hoverEnabled(): boolean {
    return !(
      this._configurationService.get('scm.blame.editorDecoration.disableHover', false) ?? false
    )
  }

  private get _ignoreWhitespace(): boolean {
    return this._configurationService.get('scm.blame.ignoreWhitespace', false) ?? false
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

      this._editorStore.add(
        editor.onDidChangeCursorPosition(() => {
          // Cached blame renders instantly; a miss (right after an edit cleared
          // it) rides the delayer so the content+cursor event pair a keystroke
          // fires never reruns the provider per key.
          const path = this._activePath
          if (
            path &&
            this._cache.has(
              blameCacheKey(
                resolveScmProviderId(
                  this._scm.sourceControls.get(),
                  path,
                  scmViewState.selectedRepo.get(),
                ),
                path,
              ),
            )
          )
            this._refresh()
          else this._scheduleRefresh()
        }),
      )
      const model = editor.getModel()
      if (model) {
        this._editorStore.add(
          model.onDidChangeContent(() => {
            // Edits invalidate every provider slot for this path.
            for (const key of [...this._cache.keys()]) {
              if (key.endsWith(`\n${this._activePath ?? ''}`)) this._cache.delete(key)
            }
            this._scheduleRefresh()
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

  /** Debounced refresh; a superseded trigger rejects with CancellationError — expected. */
  private _scheduleRefresh(): void {
    void this._blameDelayer.trigger(async () => this._refresh()).catch(() => undefined)
  }

  /** Open the blame commit in its provider's history graph (status-bar click,
   *  hover link). Args come from the hover link; the status-bar click relies on
   *  the current-line fallback. */
  private _openCommit(hash?: string, providerId?: string): Promise<unknown> {
    const provider = providerId ?? this._activeProviderId
    if (!provider) return Promise.resolve(undefined)
    const target = hash ?? this._currentHash
    if (!target) return Promise.resolve(undefined)
    return this._commandService.executeCommand(openCommitGraphCommand(provider), target)
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
    // Snapshot alongside the fetch: the status-bar entry's click target must
    // name the provider that produced the blame being shown.
    const providerId = resolveScmProviderId(
      this._scm.sourceControls.get(),
      path,
      scmViewState.selectedRepo.get(),
    )

    const seq = ++this._refreshSeq
    void this._getBlame(path).then((result) => {
      // Bail if a newer refresh superseded this one (its fetch may resolve out
      // of order — e.g. the fallback provider's slow blame landing after the
      // restored selection's provider answered) or the editor/cursor moved on.
      if (seq !== this._refreshSeq) return
      if (this._activeEditor !== editor || editor.getPosition()?.lineNumber !== line) return
      this._activeProviderId = providerId
      this._render(result ? this._resolveLine(result, line, providerId) : undefined)
    })
  }

  private _getBlame(path: string): Promise<BlameResultDto | null> {
    // Resolve which SCM provider owns this file and address its blame command.
    // A provider registers `<id>.getBlame` only after it activates (and never in a
    // non-SCM workspace), so probe the registry first — a miss isn't cached, so a
    // later activation still retries.
    const providerId = resolveScmProviderId(
      this._scm.sourceControls.get(),
      path,
      scmViewState.selectedRepo.get(),
    )
    const key = blameCacheKey(providerId, path)
    if (this._cache.has(key)) return Promise.resolve(this._cache.get(key) ?? null)
    if (!providerId) return Promise.resolve(null)
    const commandId = blameCommandId(providerId)
    if (!CommandsRegistry.getCommand(commandId)) return Promise.resolve(null)
    const existing = this._inflight.get(key)
    if (existing) return existing

    const started = performance.now()
    const p = this._commandService
      .executeCommand<BlameResultDto | null>(commandId, path, this._ignoreWhitespace)
      .then((r) => {
        this._inflight.delete(key)
        const blameMs = performance.now() - started
        if (blameMs > 1000) {
          this._logger.info(
            `blame ${path} took ${blameMs.toFixed(0)}ms commits=${r?.commits.length ?? 0} uncommitted=${r?.uncommittedLines.length ?? 0}`,
          )
        }
        // `undefined` means the command isn't registered yet (extension host still
        // activating) — don't cache it so a later cursor move retries. `null` is a
        // real "no blame for this file" answer and is cached.
        if (r === undefined) return null
        this._cache.set(key, r)
        return r
      })
      .catch(() => {
        this._inflight.delete(key)
        return null
      })
    this._inflight.set(key, p)
    return p
  }

  private _resolveLine(
    result: BlameResultDto,
    line: number,
    providerId: string | undefined,
  ): ResolvedLineBlame | undefined {
    if (result.uncommittedLines.includes(line)) {
      const text = localize('scm.blame.notCommittedYet', 'Not Committed Yet')
      return { decorationText: text, statusBarText: text }
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
      this._configurationService.get('scm.blame.editorDecoration.template', DEFAULT_TEMPLATE) ??
      DEFAULT_TEMPLATE
    const statusBarTemplate =
      this._configurationService.get(
        'scm.blame.statusBarItem.template',
        DEFAULT_STATUSBAR_TEMPLATE,
      ) ?? DEFAULT_STATUSBAR_TEMPLATE
    // The hash is a `command:` link opening the commit in the graph (dispatched
    // via the monaco-side registration of OPEN_COMMIT_COMMAND).
    const hashLinkArgs = encodeURIComponent(
      JSON.stringify(providerId ? [commit.hash, providerId] : [commit.hash]),
    )
    const hover = [
      `**${commit.authorName}** <${commit.authorEmail}>`,
      '',
      commit.summary,
      '',
      `${new Date(commit.authorDate).toLocaleString()} (${ago})`,
      '',
      // The quoted link title replaces the raw `command:` URI as the tooltip
      // text (monaco's markdown renderer uses `title || href` for the `<a>`).
      `[\`${commit.hash.slice(0, 8)}\`](command:${OPEN_COMMIT_COMMAND}?${hashLinkArgs} "${localize('scm.blame.openCommitTooltip', 'Open Commit')}")`,
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
    // Only wire the click-through when this provider actually contributes a
    // history graph (a future provider without one still gets blame text).
    const providerId = this._activeProviderId
    const hasGraph =
      providerId !== undefined &&
      CommandsRegistry.getCommand(`${providerId}-graph.view`) !== undefined
    const entry = {
      text: blame.statusBarText,
      tooltip: localize('scm.blame.statusBarTooltip', 'Blame'),
      alignment: StatusBarAlignment.Right,
      priority: 95,
      ...(blame.hash && hasGraph ? { command: OPEN_COMMIT_COMMAND } : {}),
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
    if (!path) return null
    const cached = this._cache.get(
      blameCacheKey(
        resolveScmProviderId(this._scm.sourceControls.get(), path, scmViewState.selectedRepo.get()),
        path,
      ),
    )
    const providerId = resolveScmProviderId(
      this._scm.sourceControls.get(),
      path,
      scmViewState.selectedRepo.get(),
    )
    if (!cached) return null
    const resolved = this._resolveLine(cached, position.lineNumber, providerId)
    if (!resolved?.hover) return null
    return { contents: [{ value: resolved.hover, isTrusted: true }] }
  }

  private _clear(): void {
    this._blameDelayer.cancel()
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
    this._activeProviderId = undefined
  }
}
