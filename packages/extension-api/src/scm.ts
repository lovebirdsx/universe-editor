/**
 * The `scm` namespace — source control integration, the Universe equivalent of
 * VSCode's SCM API. An extension creates a `SourceControl`, fills resource groups
 * with `SourceControlResourceState`s, and reads its commit message from
 * `inputBox.value`. Every object here is a host-side handle whose state is
 * mirrored to the editor's built-in SCM view over RPC; the view is owned by the
 * editor (extensions only provide providers, exactly like VSCode).
 */
import type { Event } from './index.js'

/** A command reference an SCM contribution can attach to a resource / input. */
export interface Command {
  command: string
  title: string
  tooltip?: string
  disabled?: boolean
  /** Optional codicon id, e.g. for a commit-bar dropdown entry. */
  icon?: string
  arguments?: unknown[]
}

/** Visual treatment for a resource state row in the SCM view. */
export interface SourceControlResourceDecorations {
  strikeThrough?: boolean
  faded?: boolean
  tooltip?: string
  /** Foreground color (any CSS color), e.g. for added / deleted resources. */
  color?: string
  /** Codicon id rendered before the resource label, e.g. `diff-modified`. */
  iconPath?: string
}

/** One changed resource (a file) within a group. */
export interface SourceControlResourceState {
  /** Filesystem path of the resource (absolute). */
  readonly resourceUri: string
  /** Run when the row is clicked (typically opens a diff). */
  readonly command?: Command
  readonly decorations?: SourceControlResourceDecorations
  /** Surfaced to menu `when` clauses as `scmResourceState`. */
  readonly contextValue?: string
}

/**
 * A hint about a file's *server-side* condition, independent of whether the user
 * changed it. Rendered as trailing grey text on the Explorer row, so a provider
 * can flag "you are behind on this file" or "someone else has it checked out"
 * without putting the file in a resource group — those files are not the user's
 * changes, and at workspace scale there can be thousands of them.
 *
 * Resource-group decorations still own the status letter / colour ("what I
 * did"); this channel only owns the grey description ("what's happening on the
 * server"). The two merge per-field and never contend.
 */
export interface SourceControlSupplementaryDecoration {
  /** Filesystem path of the file (absolute). Folders are ignored. */
  readonly resourceUri: string
  /** Short grey text after the file name, e.g. "↓" / "✎". */
  readonly description: string
  /** Appended to the row's hover tooltip, e.g. the concrete revisions. */
  readonly tooltip?: string
}

/** Options for {@link SourceControl.createResourceGroup}. */
export interface SourceControlResourceGroupOptions {
  /**
   * Id of another group this one nests under, so the view renders it as a child
   * of that group instead of a top-level sibling (e.g. p4's shelved files under
   * their owning changelist). The parent must be a group of the same provider;
   * an unknown parent id falls back to top-level rendering.
   */
  readonly parentId?: string
}

/** A named bucket of resource states, e.g. "Staged Changes" / "Changes". */
export interface SourceControlResourceGroup {
  readonly id: string
  /** Id of the parent group this one nests under, when created with one. */
  readonly parentId: string | undefined
  label: string
  hideWhenEmpty: boolean | undefined
  /** Assigning replaces the group's rows and re-renders the view. */
  resourceStates: SourceControlResourceState[]
  dispose(): void
}

/** The commit-message box. Two-way: host writes clear it, user typing updates it. */
export interface SourceControlInputBox {
  value: string
  placeholder: string
  /** Fires with the new value whenever the user edits the box in the view. */
  readonly onDidChange: Event<string>
}

/** One changed path the provider reports as a working-tree hint, mirroring the
 *  wire's `WorkingTreeChangeDto` (extension-api cannot import extensions-common,
 *  so the shape is inlined). */
export interface SourceControlWorkingTreeChange {
  /** Local path (host-side, absolute). */
  readonly path: string
  /** Single status letter for the row badge. */
  readonly letter: string
  readonly color: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
}

/**
 * One directory batch of a provider's background working-tree scan: the
 * directory that was scanned plus every change found under it. An empty
 * `changes` array means "scanned, clean" — the provider sends no negative
 * entry for it; see {@link SourceControl.publishWorkingTreeScan}.
 */
export interface SourceControlWorkingTreeScanEntry {
  /** Local directory the scan covered (host-side, absolute). */
  readonly directory: string
  readonly changes: readonly SourceControlWorkingTreeChange[]
}

export interface SourceControl {
  readonly id: string
  readonly label: string
  readonly rootUri: string | undefined
  readonly inputBox: SourceControlInputBox
  /** Badge count shown on the provider (e.g. number of changes). */
  count: number | undefined
  commitTemplate: string | undefined
  /**
   * The commit the provider's HEAD points to, or undefined when there is no
   * HEAD (empty repo). Setting this lets the editor invalidate its cached HEAD
   * content exactly when the HEAD actually moved instead of guessing from file
   * status.
   */
  headRevision: string | undefined
  /** Primary action wired to the commit button / accept gesture. */
  acceptInputCommand: Command | undefined
  /**
   * Optional list of commit-bar actions (primary first). When set with more than
   * one entry, the view renders a split button: the primary action plus a
   * dropdown of the rest, remembering the last-picked one as the sticky default.
   * A provider with a single accept gesture leaves this unset and just sets
   * `acceptInputCommand`.
   */
  acceptInputActions: Command[] | undefined
  createResourceGroup(
    id: string,
    label: string,
    options?: SourceControlResourceGroupOptions,
  ): SourceControlResourceGroup
  /**
   * Replace the provider's whole set of supplementary decorations (see
   * {@link SourceControlSupplementaryDecoration}). Whole-set semantics keep the
   * extension side trivial — pass everything you currently know, and anything
   * absent is cleared. The host diffs against the previous set, so a steady
   * state costs no RPC traffic.
   */
  setSupplementaryDecorations(decorations: readonly SourceControlSupplementaryDecoration[]): void
  /**
   * Push one batch of the provider's background working-tree scan (see
   * {@link SourceControlWorkingTreeScanEntry}). Batches accumulate as the scan
   * progresses: each entry adds the changes it found for its directory, and a
   * clean directory publishes no negative entry — the renderer keeps whatever it
   * learned earlier for that directory until a later batch (or its own
   * invalidation) says otherwise. This is a background-discovery channel — it
   * feeds Explorer folder tints ahead of any file row being rendered, and must
   * never be used to publish state that belongs in a resource group.
   */
  publishWorkingTreeScan(entries: readonly SourceControlWorkingTreeScanEntry[]): void
  dispose(): void
}

export interface ScmApi {
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
}
