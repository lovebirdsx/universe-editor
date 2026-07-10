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

/** A named bucket of resource states, e.g. "Staged Changes" / "Changes". */
export interface SourceControlResourceGroup {
  readonly id: string
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

export interface SourceControl {
  readonly id: string
  readonly label: string
  readonly rootUri: string | undefined
  readonly inputBox: SourceControlInputBox
  /** Badge count shown on the provider (e.g. number of changes). */
  count: number | undefined
  commitTemplate: string | undefined
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
  createResourceGroup(id: string, label: string): SourceControlResourceGroup
  dispose(): void
}

export interface ScmApi {
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
}
