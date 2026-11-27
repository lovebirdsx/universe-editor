/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmDiffEditorInput — a virtual EditorInput for one file's diff inside a Swarm
 *  review, carrying the review id, depot path, both diff sides' text, and the two
 *  version numbers being compared. Unlike the generic DiffEditorInput, this input
 *  keeps the review/version/file context that the inline-comment layer needs to
 *  anchor comments (Swarm context.leftLine/rightLine + version). The identity is
 *  keyed on review + file + version pair so distinct comparisons never dedupe into
 *  one tab (see apps/editor/src/renderer/services/editor/CLAUDE.md).
 *
 *  Both sides' text and the Swarm context are serialized, so history (Alt+←),
 *  Ctrl+Shift+T and workspace restore rebuild the same frozen snapshot without
 *  re-reading p4. Oversized snapshots degrade to a contentDropped payload that
 *  deserialize rejects (only workspace persistence is budgeted; same-session
 *  reopen keeps the full text).
 *--------------------------------------------------------------------------------------------*/

import {
  IFileService,
  IInstantiationService,
  URI,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput, type ISerializedDiffEditor } from './DiffEditorInput.js'

export interface SwarmDiffContext {
  readonly reviewId: string
  readonly depotFile: string
  readonly displayPath: string
  /** Current client workspace path, or null when the depot file is not mapped. */
  readonly localPath: string | null
  /** Left side REV number (display + comment anchoring): 0 = review base,
   *  1+ = review version, null = file absent. */
  readonly leftVersion: number | null
  /** Right (target) side rev number, or null for a deleted file. */
  readonly rightVersion: number | null
  /** Left side's backing p4 change (shelf snapshot), null for the depot base or
   *  an absent file. Pending versions of an unapproved review share one rev
   *  number, so the change — not the rev — is what makes two diffs distinct. */
  readonly leftChange?: string | null
  /** Right side's backing p4 change, or null for a deleted file. */
  readonly rightChange?: string | null
}

export interface ISerializedSwarmDiffEditor extends ISerializedDiffEditor {
  readonly context: SwarmDiffContext
}

function swarmFileUri(context: SwarmDiffContext): URI {
  return URI.from({ scheme: 'swarm', path: `/${context.displayPath}` })
}

/** Validate a persisted context (also rejects the older payload shape that
 *  predates this field), returning a fresh object with optional members omitted
 *  rather than set to undefined (exactOptionalPropertyTypes). */
export function parseSwarmDiffContext(raw: unknown): SwarmDiffContext | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const isNullableNumber = (v: unknown): v is number | null =>
    v === null || (typeof v === 'number' && Number.isFinite(v))
  const localPath = c.localPath
  if (localPath !== null && typeof localPath !== 'string') return null
  if (!isNullableNumber(c.leftVersion) || !isNullableNumber(c.rightVersion)) return null
  const leftChange = c.leftChange
  const rightChange = c.rightChange
  if (leftChange !== undefined && leftChange !== null && typeof leftChange !== 'string') return null
  if (rightChange !== undefined && rightChange !== null && typeof rightChange !== 'string') {
    return null
  }
  if (typeof c.reviewId !== 'string' || c.reviewId.length === 0) return null
  if (typeof c.depotFile !== 'string' || c.depotFile.length === 0) return null
  if (typeof c.displayPath !== 'string' || c.displayPath.length === 0) return null
  return {
    reviewId: c.reviewId,
    depotFile: c.depotFile,
    displayPath: c.displayPath,
    localPath,
    leftVersion: c.leftVersion,
    rightVersion: c.rightVersion,
    ...(leftChange !== undefined ? { leftChange } : {}),
    ...(rightChange !== undefined ? { rightChange } : {}),
  }
}

/** The tab-identity string for a swarm diff — exported so callers (e.g. the
 *  review editor's reopen shortcut) can compute the id without an instance. */
export function swarmDiffEditorId(context: SwarmDiffContext): string {
  return `swarmDiff:${context.reviewId}:${context.depotFile}:${context.leftChange ?? context.leftVersion ?? ''}-${context.rightChange ?? context.rightVersion ?? ''}`
}

export class SwarmDiffEditorInput extends DiffEditorInput {
  static readonly TYPE_ID: string = 'swarmDiff'

  constructor(
    private readonly _context: SwarmDiffContext,
    originalContent: string,
    modifiedContent: string,
    @IFileService fileService: IFileService,
  ) {
    super(
      swarmFileUri(_context),
      originalContent,
      modifiedContent,
      undefined,
      _context.localPath ? URI.file(_context.localPath) : undefined,
      false,
      fileService,
    )
  }

  get context(): SwarmDiffContext {
    return this._context
  }

  /** A file: URI over the display path, used for language detection + labels. */
  get fileUri(): URI {
    return this.originalUri
  }

  override get typeId(): string {
    return SwarmDiffEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({
      scheme: 'swarm-diff',
      path: `/${this._context.reviewId}/${this._context.displayPath}`,
      query: `l=${this._context.leftChange ?? this._context.leftVersion ?? ''}&r=${this._context.rightChange ?? this._context.rightVersion ?? ''}`,
    })
  }

  override get id(): string {
    return swarmDiffEditorId(this._context)
  }

  override getName(): string {
    const base = this._context.displayPath.split('/').pop() ?? this._context.displayPath
    const sideLabel = (version: number | null, change: string | null | undefined): string => {
      if (version === null) return '∅'
      if (version === 0) return 'base'
      // Pending versions share a rev, so include the backing change when known —
      // otherwise two same-rev shelves produce indistinguishable tab names.
      return change ? `v${version} (${change})` : `v${version}`
    }
    const l = sideLabel(this._context.leftVersion, this._context.leftChange)
    const r = sideLabel(this._context.rightVersion, this._context.rightChange)
    return `${base} (${l} ↔ ${r})`
  }

  override serialize(): ISerializedSwarmDiffEditor {
    return { ...super.serialize(), context: this._context }
  }

  /** Rebuild the frozen snapshot from history / Ctrl+Shift+T / workspace
   *  restore. The base `serializeForPersistence` budget already applies: its
   *  in-budget branch calls this overridden `serialize()` (so the context rides
   *  along), and its over-budget branch sets contentDropped, which we reject. */
  static deserialize(data: unknown, accessor?: ServicesAccessor): SwarmDiffEditorInput | null {
    const d = data as ISerializedSwarmDiffEditor | null
    if (!d || d.contentDropped) return null
    if (!accessor) return null
    if (typeof d.originalContent !== 'string' || typeof d.modifiedContent !== 'string') return null
    const context = parseSwarmDiffContext(d.context)
    if (!context) return null
    const inst = accessor.get(IInstantiationService)
    return inst.createInstance(SwarmDiffEditorInput, context, d.originalContent, d.modifiedContent)
  }
}
