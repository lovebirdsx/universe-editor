/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mirrors open editor documents into the trusted extension host so language
 *  plugins see `workspace.textDocuments` and the `onDidChangeTextDocument` family.
 *  Pushes the full text once on open, then debounced INCREMENTAL deltas on change
 *  (VSCode parity: a multi-MB document must never re-cross the wire per edit),
 *  and fires `onLanguage:<id>` activation so a plugin lazily starts on first touch.
 *  Generic counterpart to VSCode's ExtHostDocuments wiring; every built-in
 *  language plugin (typescript, markdown, …) consumes this single path.
 *
 *  出站载荷自带边界：按字符/条数封顶、每文档至多一个批在线、超限只留「下次推整篇」标记——
 *  整篇在推送时才读，提前读只是把开销挪个位置。读数见 DocumentSyncStats 与 docpush/docdrop。
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  DisposableStore,
  IEditorService,
  ILoggerService,
  IWorkspaceService,
  URI,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  languageActivationEvent,
  type IExtHostDocuments,
  type TextDocumentContentChangeDto,
} from '@universe-editor/extensions-common'
import { type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  MonacoModelRegistry,
  monacoModelKey,
} from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { basenameOfResource, extensionOfBasename } from '../workbench/files/resourceInfo.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { PendingDocumentSync } from '../services/extensions/PendingDocumentSync.js'
import {
  DocumentSyncStats,
  type DocumentSyncStatsWriter,
} from '../services/extensions/documentSyncStats.js'
import { bumpHeapFlow } from '../services/memory/heapFlowCounters.js'
import {
  DocumentMirrorTracking,
  type IDocumentMirrorTracker,
} from '../services/extensions/DocumentMirrorTracking.js'
import { monacoChangesToContentChanges } from '../services/extensions/documentSyncChanges.js'

const DIDCHANGE_DEBOUNCE_MS = 200

/** Upper bound for whenOpened() waiting on a model that never mounts (e.g. an
 *  untitled buffer saved without the editor ever rendering): give up and let
 *  the caller skip the push rather than hang a save notification forever. Also
 *  bounds a flush waiting on an open that never lands. */
const MIRROR_OPEN_TIMEOUT_MS = 5_000

/** Above this many characters, open/flush pushes get an info log with timings so
 *  a large-document stall is attributable in the Output panel. */
const LARGE_DOC_LOG_THRESHOLD = 1024 * 1024

/** 每文档在线的批之外允许积压的 delta 上限：越过就丢弃积压、改为欠一次整篇推送，
 *  继续累积才是把「宿主慢一次」放大成无界推送的那条路。 */
const MAX_PENDING_CHARS = 2 * 1024 * 1024
const MAX_PENDING_ENTRIES = 1000

/** 大文档上每次击键都会触发上限；一个窗口一条日志说明积压被丢，只带计数不带文本。 */
const BACKLOG_LOG_INTERVAL_MS = 10_000

/** File extension → LSP languageId where it diverges from Monaco's model id.
 *  Only `.jsx` diverges now (`.tsx` has its own `typescriptreact` model id); the
 *  React variants matter because they are what makes tsserver enable JSX. */
const LSP_LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascriptreact',
}

function resolveLanguageId(resource: URI, model: monaco.editor.ITextModel): string {
  const ext = extensionOfBasename(basenameOfResource(resource))
  return (ext ? LSP_LANGUAGE_BY_EXT[ext] : undefined) ?? model.getLanguageId()
}

function sumChangeChars(changes: readonly { readonly text: string }[]): number {
  let sum = 0
  for (const change of changes) sum += change.text.length
  return sum
}

interface OpenDoc {
  readonly store: DisposableStore
  readonly model: monaco.editor.ITextModel
  /** 本镜像的读数句柄；语言切换重建镜像后，旧句柄的写入自动失效 */
  readonly stats: DocumentSyncStatsWriter
  languageId: string
  timer?: ReturnType<typeof setTimeout> | undefined
  /** 本世代的 open 已 ack；未 ack 前不放行 delta 批。 */
  opened: boolean
  /** 上一批离开后按事件顺序入队的 delta；`pendingFull` 时恒为空。 */
  pending: TextDocumentContentChangeDto[]
  /** Σ pending[].text.length：入队时累加，上限判定不遍历积压。 */
  pendingChars: number
  /** 积压已丢弃（整篇重置 / 超限 / 批次失败）：下次推整篇而不是打补丁。 */
  pendingFull: boolean
  /** 宿主已 ack 的最高模型版本；flush 等它追平调用时的版本。 */
  ackedVersion: number
  /** 允许在线的唯一批次；宿主 ack 后 resolve true。 */
  inflight?: Promise<boolean> | undefined
  /** 每次 open 递增：被取代的 open 落地时不得认领状态。 */
  generation: number
  /** open 期间的重复请求：由在跑的序列在结尾合并成一次后续 open。 */
  reopen: boolean
  /** 在线的 open；`flush` 等它——宿主将持有的就是这份文本。 */
  openLanding?: Promise<void> | undefined
  /** 活镜像所在的 documents 代理：重启会换掉它，往旧代理推的 delta 被宿主丢弃（没有先前的
   *  open），文档会静默变旧。 */
  documents?: IExtHostDocuments | undefined
  /** 已摘除：条目、宿主、读数都不许再碰。 */
  dead: boolean
}

interface OpenWaiter {
  readonly settle: (opened: boolean) => void
  timer?: ReturnType<typeof setTimeout>
}

export class DocumentSyncContribution
  extends Disposable
  implements IWorkbenchContribution, IDocumentMirrorTracker
{
  /** Synced documents, keyed by model URI string. Kept open across editor switches. */
  private readonly _open = new Map<string, OpenDoc>()
  /** whenOpened() callers waiting on a document's open push, keyed the same way. */
  private readonly _openWaiters = new Map<string, Set<OpenWaiter>>()
  /** Languages already activated this host generation; reset on host relaunch. */
  private readonly _activated = new Set<string>()
  private readonly _logger: ILogger
  private _backlogLoggedAt = 0

  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'docSync', name: 'Document Sync' })
    DocumentMirrorTracking.register(this)
    this._register(
      autorun((r) => {
        this._editorService.activeEditor.read(r)
        this._sync()
      }),
    )
    // Monaco mounts asynchronously after the input becomes active.
    this._register(FileEditorRegistry.onDidChange(() => this._sync()))
    // A markdown preview reached via a link acquires its source model on demand
    // (async), after the active-editor autorun already ran and found none. Sync
    // when that model appears so the language service sees the document.
    this._register(MonacoModelRegistry.onDidAddModel(() => this._sync()))
    // The host pins the workspace at launch and relaunches on a folder swap; its
    // fresh ExtHostDocuments is empty, so re-push every open document afterwards.
    this._register(this._workspace.onDidChangeWorkspace(() => this._resyncAll()))
  }

  /**
   * IDocumentMirrorTracker: attach `model` (the model for `resource`) to the sync
   * pipeline unless it is already tracked. Used by `MainThreadEditor.$openTextDocument`
   * so a document opened via `workspace.openTextDocument` mirrors like one opened
   * in an editor.
   */
  trackModel(resource: URI, model: monaco.editor.ITextModel): boolean {
    const key = model.uri.toString()
    if (this._open.has(key)) return true
    this._attach(key, model, resolveLanguageId(resource, model))
    return true
  }

  /** IDocumentMirrorTracker: whether the document for `resource` is already mirrored. */
  isTracked(resource: URI): boolean {
    const model = MonacoModelRegistry.peek(resource)
    return model !== undefined && this._open.has(model.uri.toString())
  }

  /**
   * IDocumentMirrorTracker: resolve once the document's open push has landed on
   * the host (immediately when already open). False when the document never
   * attaches/opens within `timeoutMs`, or the pipeline tears down first.
   */
  whenOpened(resource: URI, timeoutMs = MIRROR_OPEN_TIMEOUT_MS): Promise<boolean> {
    const model = MonacoModelRegistry.peek(resource)
    // Without a model there is no attach key yet — predict it the same way the
    // registry keys a future model so the waiter meets _attach's key.
    const key = model ? model.uri.toString() : monacoModelKey(resource)
    if (this._open.get(key)?.opened === true) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const waiter: OpenWaiter = {
        settle: (opened) => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          const waiters = this._openWaiters.get(key)
          if (waiters) {
            waiters.delete(waiter)
            if (waiters.size === 0) this._openWaiters.delete(key)
          }
          resolve(opened)
        },
      }
      waiter.timer = setTimeout(() => waiter.settle(false), timeoutMs)
      const waiters = this._openWaiters.get(key) ?? new Set<OpenWaiter>()
      waiters.add(waiter)
      this._openWaiters.set(key, waiters)
    })
  }

  private _settleOpenWaiters(key: string, opened: boolean): void {
    const waiters = this._openWaiters.get(key)
    if (!waiters) return
    for (const waiter of [...waiters]) waiter.settle(opened)
  }

  private _sync(): void {
    const input = this._editorService.activeEditor.get()

    // A markdown preview has no model of its own; mirror its source file's shared
    // model so language plugins see the document and the Outline view fills in.
    if (input instanceof MarkdownPreviewInput) {
      const model = MonacoModelRegistry.peek(input.sourceUri)
      if (!model) return
      const key = model.uri.toString()
      if (this._open.has(key)) return
      this._attach(key, model, resolveLanguageId(input.sourceUri, model))
      return
    }

    // An untitled buffer mirrors too (VSCode parity: `workspace.textDocuments`
    // lists untitled documents). Its model exists once the editor (or an earlier
    // programmatic open) resolved it; the registry's add event retries until then.
    if (input instanceof UntitledEditorInput) {
      const model = MonacoModelRegistry.peek(input.resource)
      if (!model) return
      const key = model.uri.toString()
      if (this._open.has(key)) return
      this._attach(key, model, resolveLanguageId(input.resource, model))
      return
    }

    if (!(input instanceof FileEditorInput)) return

    const editor = FileEditorRegistry.get(input)
    const model = editor?.getModel() ?? MonacoModelRegistry.peek(input.resource)
    if (!model) return // not mounted yet; FileEditorRegistry.onDidChange will retry

    const key = model.uri.toString()
    if (this._open.has(key)) return
    this._attach(key, model, resolveLanguageId(input.resource, model))
  }

  private _attach(key: string, model: monaco.editor.ITextModel, languageId: string): void {
    this._logger.info(`attach ${key} language=${languageId}`)
    const store = this._register(new DisposableStore())
    const entry: OpenDoc = {
      store,
      model,
      // 从 attach 起就计读数：宿主还没起来的文档也有积压，那正是要看的数
      stats: DocumentSyncStats.track(key),
      languageId,
      opened: false,
      pending: [],
      pendingChars: 0,
      pendingFull: false,
      ackedVersion: 0,
      generation: 0,
      reopen: false,
      dead: false,
    }
    this._open.set(key, entry)
    this._startOpen(key, entry)

    store.add(model.onDidChangeContent((e) => this._onChange(key, entry, e)))
    store.add(model.onWillDispose(() => this._detach(key)))

    // A language switch (setTextDocumentLanguage / user "Change Language Mode")
    // re-mirrors the document as close(old) + open(new): Monaco fires
    // onDidChangeLanguage inside setModelLanguage, so detach + re-attach here makes
    // the API path and the manual mode switch flow through this one sync pipeline.
    store.add(
      model.onDidChangeLanguage(() => {
        const newLanguageId = model.getLanguageId()
        if (newLanguageId === entry.languageId) return
        this._detach(key)
        this._attach(key, model, newLanguageId)
      }),
    )

    // Let a completion (which fires immediately on a trigger char) force the
    // host's mirror current before it runs, beating the 200ms debounce above.
    PendingDocumentSync.register(key, () => this._flush(entry))
  }

  private _onChange(key: string, entry: OpenDoc, e: monaco.editor.IModelContentChangedEvent): void {
    if (entry.dead) return
    if (e.isFlush) {
      // 整篇重置（文件重载、setValue）：没有有意义的 delta，一次整篇推送即可
      this._oweFullText(key, entry, entry.pendingChars, false)
    } else if (entry.pendingFull) {
      // 整篇已经欠着，这些 delta 只会同样被丢
      bumpHeapFlow('docdrop', sumChangeChars(e.changes))
    } else {
      const added = sumChangeChars(e.changes)
      if (
        entry.pending.length + e.changes.length > MAX_PENDING_ENTRIES ||
        entry.pendingChars + added > MAX_PENDING_CHARS
      ) {
        // 放大器就在这里：线程卡住时，积压唯一的上界就是这两条上限
        this._oweFullText(key, entry, entry.pendingChars + added, true)
      } else {
        entry.pending.push(...monacoChangesToContentChanges(e.changes))
        entry.pendingChars += added
        entry.stats.setPending(entry.pending.length, entry.pendingChars, false)
      }
    }
    entry.stats.setOpenChars(entry.model.isDisposed() ? 0 : entry.model.getValueLength())
    this._schedule(entry)
  }

  /** 丢弃积压、改为欠一次整篇推送。文本在推送时才读：调用方通常正是卡住的线程，
   *  在这里读只是把开销挪个位置。 */
  private _oweFullText(key: string, entry: OpenDoc, droppedChars: number, report: boolean): void {
    entry.pending = []
    entry.pendingChars = 0
    entry.pendingFull = true
    if (droppedChars > 0) bumpHeapFlow('docdrop', droppedChars)
    entry.stats.setPending(0, 0, true)
    if (report) this._logBacklog(key, droppedChars)
  }

  private _logBacklog(key: string, droppedChars: number): void {
    const now = Date.now()
    if (now - this._backlogLoggedAt < BACKLOG_LOG_INTERVAL_MS) return
    this._backlogLoggedAt = now
    this._logger.warn(
      `pending backlog dropped for ${key}: dropped=${droppedChars} chars, full text owed (cap ${MAX_PENDING_CHARS} chars / ${MAX_PENDING_ENTRIES} entries)`,
    )
  }

  /** 200ms 去抖，按事件重启，于是一串连续输入共乘一个批次。 */
  private _schedule(entry: OpenDoc): void {
    if (entry.dead) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this._ignore(this._push(entry))
    }, DIDCHANGE_DEBOUNCE_MS)
  }

  /** 该项是否仍是 `key` 当前的活镜像。 */
  private _owns(key: string, entry: OpenDoc): boolean {
    return !entry.dead && this._open.get(key) === entry
  }

  /** `generation` 代表的这次 open 是否仍是要生效的那次。 */
  private _isLive(key: string, entry: OpenDoc, generation: number): boolean {
    return entry.generation === generation && this._owns(key, entry)
  }

  /** 请求一次（或再一次）open；同一文档同时只有一个 open 序列。 */
  private _startOpen(key: string, entry: OpenDoc): void {
    entry.reopen = true
    this._drainOpen(key, entry)
  }

  /**
   * open 与在线的 change 批串行：先等批落地再打开，否则旧批的 ack 会算到新镜像头上。
   * 序列进行中再次请求（resync / 语言切换）只置 `reopen`，由本次序列在结尾合并重开。
   */
  private _drainOpen(key: string, entry: OpenDoc): void {
    if (entry.dead || entry.openLanding !== undefined) return
    const landing = this._openSequence(key, entry)
    entry.openLanding = landing
    void landing
      .catch(() => undefined)
      .then(() => {
        if (entry.openLanding === landing) entry.openLanding = undefined
      })
  }

  private async _openSequence(key: string, entry: OpenDoc): Promise<void> {
    const generation = ++entry.generation
    do {
      entry.reopen = false
      const inflight = entry.inflight
      if (inflight !== undefined) await inflight
      if (!this._isLive(key, entry, generation)) return
      await this._openDoc(key, entry, generation)
    } while (entry.reopen && this._isLive(key, entry, generation))
  }

  private async _openDoc(key: string, entry: OpenDoc, generation: number): Promise<void> {
    // 本次 open 从这一刻起独占该文档：`opened` 为假期间 `_push` 不放行任何批，否则「等激活」那段
    // （宿主重启时可能是秒级）里到期的防抖会先发一批，同一文档的全文与增量同时在途。
    entry.opened = false
    // 激活先行：宿主可能还没起来，激活正是把它带起来的路径——提前返回会让启动期打开的文档没有镜像。
    try {
      await this._activate(entry.languageId)
    } catch {
      return // 宿主里没有能接收这份文档的东西
    }
    if (!this._isLive(key, entry, generation) || entry.model.isDisposed()) return
    const documents = this._client.getDocuments()
    if (documents === undefined) return

    // 重置与快照同步完成：此后到达的 delta 都相对这份文本，不会被重复计入或丢失。
    entry.pending = []
    entry.pendingChars = 0
    entry.pendingFull = false
    entry.stats.setPending(0, 0, false)
    const started = performance.now()
    const text = entry.model.getValue()
    const version = entry.model.getVersionId()
    const snapshotMs = performance.now() - started
    entry.stats.setOpenChars(text.length)
    // 整篇此刻真的在手上，直到发送结束前都算管道持有的载荷
    entry.stats.setInflight(text.length)
    const sendStarted = performance.now()
    try {
      await documents.$acceptDocumentOpen(entry.model.uri, entry.languageId, version, text)
    } catch {
      return // 关停中通道已断，没什么可同步
    } finally {
      entry.stats.setInflight(0)
    }
    if (!this._isLive(key, entry, generation)) {
      // 在线期间被摘除或被取代：这次 open 建的镜像不是本项现在代表的那一个。
      // 摘除方已发（或即将发）close，取代它的 open 有自己的推送。
      return
    }
    entry.opened = true
    entry.documents = documents
    entry.ackedVersion = Math.max(entry.ackedVersion, version)
    this._settleOpenWaiters(key, true)
    if (text.length > LARGE_DOC_LOG_THRESHOLD) {
      this._logger.info(
        `didOpen ${entry.model.uri.toString()} chars=${text.length} snapshot=${snapshotMs.toFixed(1)}ms send=${(performance.now() - sendStarted).toFixed(1)}ms`,
      )
    }
    // 已有重开请求排在后面：它自己的快照会带上这些 delta，不必先推一遍
    if (entry.reopen) return
    // 激活/open 在线期间到达的 delta 现在叠加上去
    if (entry.pending.length > 0 || entry.pendingFull) this._ignore(this._push(entry))
  }

  /** Activate plugins for a language once per host generation (before pushing the
   *  document, so a plugin's `onDidOpenTextDocument` listener is already attached). */
  private async _activate(languageId: string): Promise<void> {
    if (this._activated.has(languageId)) return
    this._activated.add(languageId)
    this._logger.info(`activateByEvent ${languageActivationEvent(languageId)}`)
    await this._client.activateByEvent(languageActivationEvent(languageId))
  }

  /** 镜像活着且线上没有批时，把排队的东西发出去。返回宿主之后是否已是最新：缺宿主、需要重开
   *  镜像、或一批宿主未必应用过，都算不是。 */
  private async _push(entry: OpenDoc): Promise<boolean> {
    const key = entry.model.uri.toString()
    if (entry.dead || entry.inflight !== undefined || entry.model.isDisposed()) return false
    const documents = this._client.getDocuments()
    if (documents === undefined) {
      // 宿主走了：积压的 delta 没有可应用的基线，下一个活世代整篇重建
      this._oweFullText(key, entry, entry.pendingChars, false)
      entry.opened = false
      return false
    }
    if (!entry.opened || entry.documents !== documents) {
      // 这个宿主世代上没有镜像：首次 open 还在飞、open 失败，或被重启换掉了连接
      // （往那儿推的 delta 会被宿主丢掉：它没有这个 URI 的文档）
      entry.opened = false
      if (entry.openLanding === undefined) this._startOpen(key, entry)
      return false
    }
    if (entry.pending.length === 0 && !entry.pendingFull) return true

    const changes: TextDocumentContentChangeDto[] = entry.pendingFull
      ? [{ text: entry.model.getValue() }]
      : entry.pending
    const version = entry.model.getVersionId()
    const payloadChars = entry.pendingFull ? changes[0]!.text.length : entry.pendingChars
    entry.pending = []
    entry.pendingChars = 0
    entry.pendingFull = false
    entry.stats.setPending(0, 0, false)
    entry.stats.setInflight(payloadChars)
    bumpHeapFlow('docpush', payloadChars)

    const generation = entry.generation
    const started = performance.now()
    const batch = documents.$acceptDocumentChange(entry.model.uri, version, changes)
    const inflight = (async (): Promise<boolean> => {
      try {
        await batch
        if (payloadChars > LARGE_DOC_LOG_THRESHOLD) {
          this._logger.info(
            `didChange ${key} changes=${changes.length} chars=${payloadChars} send=${(performance.now() - started).toFixed(1)}ms`,
          )
        }
        return true
      } catch {
        return false
      } finally {
        entry.stats.setInflight(0)
      }
    })()
    entry.inflight = inflight
    const landed = await inflight
    entry.inflight = undefined
    // 落地时该项已被摘除、或已被 resync 重新打开：这一批不属于当前镜像，不得改它的进度
    if (entry.dead || entry.generation !== generation) return landed
    if (landed) {
      entry.ackedVersion = Math.max(entry.ackedVersion, version)
      // 这批在线上期间又来了新内容：它有自己的去抖窗口
      if (entry.pending.length > 0 || entry.pendingFull) this._schedule(entry)
    } else {
      // 宿主未必应用了这一批，积压的 delta 现在都相对一个它可能从未到达的状态：
      // 下次整篇镜像
      this._oweFullText(key, entry, entry.pendingChars, false)
    }
    return landed
  }

  /** 等调用时版本的 ack；open 与 change 共用截止时间，超时拒绝，不能让调用方读旧镜像。 */
  private async _flush(entry: OpenDoc): Promise<void> {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.dead) return
    const target = entry.model.getVersionId()
    const deadline = Date.now() + MIRROR_OPEN_TIMEOUT_MS
    // 仅截止调用方的等待，不清除在途请求；晚到的 ack 仍由原发送流程处理。
    await this._awaitFlushStep(entry, this._ensureMirror(entry), deadline)
    if (entry.dead || !entry.opened) return
    while (!entry.dead && entry.ackedVersion < target) {
      const inflight = entry.inflight
      if (inflight !== undefined) {
        if (!(await this._awaitFlushStep(entry, inflight, deadline))) return
        continue
      }
      // 宿主还落后但没有可推的内容：无法再推进，如实返回而不是空转
      if (!entry.pendingFull && entry.pending.length === 0) return
      if (!(await this._awaitFlushStep(entry, this._push(entry), deadline))) return
    }
  }

  /**
   * 活镜像 = 建立在客户端当前持有的连接上的镜像。重启会连同积压的 delta 一起带走它，
   * 所以找不到时重开（等待有界），而不是报告一个看不见的状态。
   */
  private async _ensureMirror(entry: OpenDoc): Promise<void> {
    const documents = this._client.getDocuments()
    if (documents !== undefined && entry.opened && entry.documents === documents) return
    if (documents !== undefined && entry.openLanding === undefined) {
      this._startOpen(entry.model.uri.toString(), entry)
    }
    await entry.openLanding
  }

  private async _awaitFlushStep<T>(entry: OpenDoc, step: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          this._logger.warn(`document sync flush timed out ${entry.model.uri.toString()}`)
          reject(new Error('Document sync flush timed out'))
        },
        Math.max(0, deadline - Date.now()),
      )
    })
    try {
      return await Promise.race([step, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Re-push every open document after a host relaunch (its mirror was reset). */
  private _resyncAll(): void {
    this._activated.clear()
    for (const [key, entry] of this._open) {
      if (entry.dead) continue
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      // 已在线的 open 由序列自己合并成一次后续 open，不会叠加成一对多余的 close/open
      this._startOpen(key, entry)
    }
  }

  /** Teardown must not leave whenOpened() callers hanging until their timeout. */
  private _settleAllOpenWaiters(): void {
    for (const key of [...this._openWaiters.keys()]) this._settleOpenWaiters(key, false)
  }

  /** Swallow IPC rejections on fire-and-forget notifications (e.g. the channel
   *  closing during shutdown) so they never surface as unhandled rejections. */
  private _ignore(p: Promise<unknown>): void {
    void p.catch(() => undefined)
  }

  private _detach(key: string): void {
    const entry = this._open.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.dead = true
    entry.pending = []
    entry.pendingChars = 0
    entry.pendingFull = false
    this._open.delete(key)
    PendingDocumentSync.unregister(key)
    entry.stats.release()
    const documents = this._client.getDocuments()
    if (documents) this._ignore(documents.$acceptDocumentClose(entry.model.uri))
    this._settleOpenWaiters(key, false)
    entry.store.dispose()
  }

  override dispose(): void {
    DocumentMirrorTracking.unregister(this)
    for (const key of [...this._open.keys()]) this._detach(key)
    this._settleAllOpenWaiters()
    // 这条管道的一切都不该活过它，读数也一样。
    DocumentSyncStats.clearAll()
    super.dispose()
  }
}
