/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Add Selection to Agent Chat — grabs every non-empty selection in the focused
 *  file editor and attaches them to an agent chat input as context chips
 *  (Cursor's Ctrl+L / Copilot's "Add Selection to Chat"). Split in two so the
 *  user decides where the selection lands: the existing-chat command reuses the
 *  chat in front (asking first only when several are open), the new-chat command
 *  always opens a fresh one.
 *
 *  Selection → SelectionContext (uri + snapshotted text + 1-based line range).
 *  The target chat's ChatBody may not be mounted when the command runs (editor
 *  mode with the session tab closed, or a session we just created), so we cannot
 *  call the widget directly. Instead we resolve/create the target session,
 *  deposit the contexts into AcpPromptContextInbox (keyed by the session's local
 *  id), then reveal + focus that chat; PromptInput drains its inbox on mount and
 *  reacts to deposits while mounted, so the hand-off survives the not-mounted →
 *  mounted transition.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  CommandsRegistry,
  fsPathToWorkspaceUri,
  ICommandService,
  IEditorService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  localize2,
  MenuId,
  URI,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'
import { AcpPromptContextInbox } from '../services/acp/session/acpPromptContextInbox.js'
import { AcpPromptRefInbox } from '../services/acp/session/acpPromptRefInbox.js'
import { AcpPromptTextInbox } from '../services/acp/session/acpPromptTextInbox.js'
import { formatChangelistText } from '../services/acp/chatContextFormat.js'
import { mentionEntryToRef } from '../services/acp/promptRef.js'
import {
  collectActiveSelectionContexts,
  type SelectionContext,
} from '../services/acp/promptContext.js'
import { resolveSessionScopeRoot } from '../services/acp/sessionScope.js'
import { toMentionName } from '../services/dnd/resourceDropTransfer.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { scmResourceArgPath } from '../services/scm/scmResourceArg.js'
import { CATEGORY } from './_agentShared.js'
import {
  captureRevealServices,
  createChatTarget,
  resolveActiveOrNewSession,
  resolveExistingChatTarget,
  revealChat,
  type RevealServices,
} from './_agentChatTarget.js'

export class AddSelectionToExistingAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.addSelectionToExistingChat'
  constructor() {
    super({
      id: AddSelectionToExistingAgentChatAction.ID,
      title: localize2(
        'action.agent.addSelectionToExistingChat',
        'Add Selection to Existing Agent Chat',
      ),
      category: CATEGORY,
      precondition: 'editorTextFocus',
      keybinding: { primary: ['ctrl+k', 'ctrl+l'] },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const contexts = collectActiveSelectionContexts(
      accessor.get(IEditorService),
      accessor.get(IWorkspaceService),
    )
    if (contexts.length === 0) return
    // Resolve every service synchronously up front: the accessor is only valid
    // during run's synchronous scope, so nothing below the first await may touch it.
    const reveal = captureRevealServices(accessor)
    const quickInput = accessor.get(IQuickInputService)
    const target = await resolveExistingChatTarget(reveal, quickInput)
    if (!target) return
    await attachContexts(reveal, target.id, contexts)
  }
}

export class AddSelectionToNewAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.addSelectionToNewChat'
  constructor() {
    super({
      id: AddSelectionToNewAgentChatAction.ID,
      title: localize2('action.agent.addSelectionToNewChat', 'Add Selection to New Agent Chat'),
      category: CATEGORY,
      precondition: 'editorTextFocus',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const contexts = collectActiveSelectionContexts(
      accessor.get(IEditorService),
      accessor.get(IWorkspaceService),
    )
    if (contexts.length === 0) return
    const reveal = captureRevealServices(accessor)
    const target = await createChatTarget(reveal)
    await attachContexts(reveal, target.id, contexts)
  }
}

// Deposit before revealing so a freshly-mounting PromptInput drains it, and an
// already-mounted one gets the onDidDeposit event — either way it lands.
async function attachContexts(
  reveal: RevealServices,
  sessionId: string,
  contexts: readonly SelectionContext[],
): Promise<void> {
  AcpPromptContextInbox.deposit(sessionId, contexts)
  await revealChat(reveal, sessionId)
}

/**
 * Resolve the chat to land in, deposit pre-composed text, then reveal it —
 * the shared tail of every "send … to Agent Chat" command. Callers pass
 * `captureRevealServices(accessor)` straight in: the ServicesAccessor dies at
 * the first await, so nothing beyond this point may read it.
 */
async function depositPromptText(reveal: RevealServices, text: string): Promise<void> {
  const target = await resolveActiveOrNewSession(reveal)
  AcpPromptTextInbox.deposit(target.id, text)
  await revealChat(reveal, target.id)
}

/** Payload for {@link SendCommitToAgentChatAction}: the Git Graph passes the
 *  clicked commit's hash and subject so the action can compose the context text. */
export interface SendCommitToAgentChatArg {
  readonly hash: string
  readonly message: string
}

/**
 * Send a commit's hash + subject to the agent chat input as plain text, so the
 * user can ask the agent about that commit. Invoked from the Git Graph commit
 * context menu with a {@link SendCommitToAgentChatArg}; not exposed in the
 * command palette (it needs the commit argument).
 */
export class SendCommitToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendCommitToChat'
  constructor() {
    super({
      id: SendCommitToAgentChatAction.ID,
      title: localize2('action.agent.sendCommitToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: SendCommitToAgentChatArg): Promise<void> {
    if (!arg || !arg.hash) return
    const subject = arg.message.trim()
    const text = subject ? `Commit ${arg.hash}: ${subject}` : `Commit ${arg.hash}`
    // Capture services before the first await — the accessor dies past it.
    await depositPromptText(captureRevealServices(accessor), text)
  }
}

/** Payload for {@link SendContextToAgentChatAction}: text the caller composed. */
export interface SendContextToAgentChatArg {
  readonly text: string
}

/**
 * Send a caller-composed context text (a Perforce changelist, a Swarm review)
 * to the agent chat input. The views that offer these entries already hold the
 * data, so the payload is the finished text — a new context source needs no new
 * action, just a menu item that knows how to render its own entry.
 */
export class SendContextToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendContextToChat'
  constructor() {
    super({
      id: SendContextToAgentChatAction.ID,
      title: localize2('action.agent.sendContextToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: SendContextToAgentChatArg): Promise<void> {
    const text = arg?.text.trim()
    if (!text) return
    await depositPromptText(captureRevealServices(accessor), text)
  }
}

/** Payload for {@link SendChangelistToAgentChatAction}: the argument the SCM view
 *  hands a group-scoped command (`cl:<n>` / `shelved:<n>` groups). */
export interface SendChangelistToAgentChatArg {
  readonly rootUri?: string
  readonly sourceControlId?: string
  readonly scmResourceGroupId?: string
}

/** Provider capability id (`<providerId>.<capability>`, like `checkIgnore`):
 *  reads a changelist's description from the p4 extension. */
const CHANGELIST_DESCRIPTION_COMMAND = 'perforce.getChangelistDescription'

/** The changelist a `cl:<n>` / `shelved:<n>` SCM group id wraps. */
function changelistIdFromGroupId(groupId: string): string | undefined {
  return /^(?:cl|shelved):(.+)$/.exec(groupId)?.[1]
}

/**
 * Send a changelist to the agent chat from the SCM view's changelist group
 * header. The group row carries only the id (the SCM API has no description
 * field), so the text is completed with the description read back from the p4
 * extension — the same shape the Perforce Graph's row entry sends.
 */
export class SendChangelistToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendChangelistToChat'
  constructor() {
    super({
      id: SendChangelistToAgentChatAction.ID,
      title: localize2('action.agent.sendChangelistToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      icon: 'sparkle',
      f1: false,
      menu: {
        id: MenuId.ScmResourceGroupContext,
        group: '4_agent@1',
        // A changelist id is what makes the entry meaningful — the default
        // group (no description, not addressable as a change) is left out.
        when: 'scmProvider == perforce && scmResourceGroup =~ /^(cl|shelved):/',
      },
    })
  }

  override async run(
    accessor: ServicesAccessor,
    arg?: SendChangelistToAgentChatArg,
  ): Promise<void> {
    const groupId = arg?.scmResourceGroupId
    const changelist = groupId !== undefined ? changelistIdFromGroupId(groupId) : undefined
    if (changelist === undefined) return
    // The menu's when-clause already pins the provider, so the capability is
    // registered — probing keeps a stale menu from rejecting in the handler.
    if (CommandsRegistry.getCommand(CHANGELIST_DESCRIPTION_COMMAND) === undefined) return
    // Capture services before the first await — the accessor dies past it.
    const commands = accessor.get(ICommandService)
    const reveal = captureRevealServices(accessor)
    const description = await commands.executeCommand<string>(CHANGELIST_DESCRIPTION_COMMAND, arg)
    await depositPromptText(reveal, formatChangelistText(changelist, description ?? ''))
  }
}

/** A file/folder destined for the prompt input as a tracked @-mention pill. */
interface AgentResourceEntry {
  readonly uri: URI
  readonly kind: 'file' | 'folder'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function reviveUriArg(value: unknown): URI | undefined {
  if (value instanceof URI) return value
  if (typeof value !== 'object' || value === null) return undefined
  return (URI.revive(value as UriComponents) as URI | undefined) ?? undefined
}

function explorerEntry(value: unknown): AgentResourceEntry | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const uri = reviveUriArg(record['target'] ?? record['resource'])
  if (!uri) return undefined
  return { uri, kind: record['isDirectory'] === true ? 'folder' : 'file' }
}

/** Explorer menu args: `(primary {target, resource, isDirectory}, selection?)`.
 *  The selection is already materialized and root-filtered by ExplorerContextMenu;
 *  when it is absent the clicked row is the only target. */
function collectExplorerEntries(
  primaryArg: unknown,
  selectionArg: unknown,
  workspaceRoot: URI | undefined,
  uriIdentity: IUriIdentityService,
): AgentResourceEntry[] {
  const primary = explorerEntry(primaryArg)
  const selection = Array.isArray(selectionArg)
    ? selectionArg
        .map((entry) => explorerEntry(entry))
        .filter((entry): entry is AgentResourceEntry => entry !== undefined)
    : []
  return dedupeResourceEntries(
    selection.length > 0 ? selection : primary ? [primary] : [],
    workspaceRoot,
    uriIdentity,
  )
}

/** SCM row payloads carry a raw host fs-path; rows the provider marks
 *  `noHostFile` (depot paths) cannot be referenced as a file resource. */
function scmEntry(value: unknown, authority: string | undefined): AgentResourceEntry | undefined {
  const record = asRecord(value)
  if (!record || record['noHostFile'] === true) return undefined
  const fsPath = scmResourceArgPath(value)
  if (fsPath === undefined) return undefined
  return { uri: fsPathToWorkspaceUri(fsPath, authority), kind: 'file' }
}

/** SCM menu args: `(primary, selection)`. A folder row's second arg is its whole
 *  subtree (getFolderFileResources) — an empty subtree sends nothing rather than
 *  falling back to a folder ref, matching the SCM folder drag source. */
function collectScmEntries(
  primaryArg: unknown,
  selectionArg: unknown,
  authority: string | undefined,
  uriIdentity: IUriIdentityService,
): AgentResourceEntry[] {
  const isFolder = asRecord(primaryArg)?.['isDirectory'] === true
  const selection = Array.isArray(selectionArg) ? selectionArg : []
  const items = selection.length > 0 ? selection : isFolder ? [] : [primaryArg]
  const entries = items
    .map((item) => scmEntry(item, authority))
    .filter((entry): entry is AgentResourceEntry => entry !== undefined)
  return dedupeResourceEntries(entries, undefined, uriIdentity)
}

function dedupeResourceEntries(
  entries: readonly AgentResourceEntry[],
  root: URI | undefined,
  uriIdentity: IUriIdentityService,
): AgentResourceEntry[] {
  const out: AgentResourceEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    // The workspace root is never a useful context item (Explorer's blank-area
    // menu falls back to it); the menu gate already hides that case.
    if (root !== undefined && uriIdentity.isEqual(entry.uri, root)) continue
    const key = uriIdentity.getComparisonKey(entry.uri)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

// Deposit refs before revealing, so a freshly-mounting PromptInput drains them
// and an already-mounted one gets the onDidDeposit event — same hand-off as
// depositPromptText. The mention labels must be relative to the session scope
// root (not the workspace root) because they enter the prompt as `@<label>` and
// the agent resolves them against its cwd.
async function depositResourceRefs(
  reveal: RevealServices,
  workspaceFolder: URI | undefined,
  uriIdentity: IUriIdentityService,
  entries: readonly AgentResourceEntry[],
): Promise<void> {
  const target = await resolveActiveOrNewSession(reveal)
  const mentionRoot = resolveSessionScopeRoot(workspaceFolder, target.cwd, uriIdentity)?.root
  const refs = entries.map((entry) => {
    const mention = toMentionName(entry.uri, mentionRoot)
    return mentionEntryToRef({ uri: mention.uri, relPath: mention.name }, entry.kind)
  })
  AcpPromptRefInbox.deposit(target.id, refs)
  await revealChat(reveal, target.id)
}

/**
 * Send Explorer files/folders to the agent chat input as @-mention pills — the
 * same end state as dropping them onto the prompt. A folder becomes one folder
 * ref; the multi-selection (when the clicked row is part of it) is sent whole.
 */
export class SendExplorerResourceToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendExplorerResourceToChat'
  constructor() {
    super({
      id: SendExplorerResourceToAgentChatAction.ID,
      title: localize2('action.agent.sendExplorerResourceToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      icon: 'sparkle',
      f1: false,
      menu: {
        id: MenuId.ExplorerContext,
        group: '7_agent',
        order: 2,
        when: '!explorerResourceIsRoot',
      },
    })
  }

  override async run(
    accessor: ServicesAccessor,
    primaryArg?: unknown,
    selectionArg?: unknown,
  ): Promise<void> {
    // Capture every service before the first await — the accessor dies past it.
    const workspace = accessor.get(IWorkspaceService)
    const uriIdentity = accessor.get(IUriIdentityService)
    const reveal = captureRevealServices(accessor)
    const workspaceFolder = workspace.current?.folder
    const entries = collectExplorerEntries(primaryArg, selectionArg, workspaceFolder, uriIdentity)
    if (entries.length === 0) return
    await depositResourceRefs(reveal, workspaceFolder, uriIdentity, entries)
  }
}

/**
 * Send SCM file rows (or a folder row's whole subtree) to the agent chat input
 * as @-mention pills. SCM paths are host fs-paths, so the window's remote
 * authority is reattached before they become resource URIs.
 */
export class SendScmResourceToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendScmResourceToChat'
  constructor() {
    super({
      id: SendScmResourceToAgentChatAction.ID,
      title: localize2('action.agent.sendScmResourceToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      icon: 'sparkle',
      f1: false,
      menu: [
        {
          id: MenuId.ScmResourceStateContext,
          group: '4_agent',
          order: 1,
          when: 'scmResourceHasHostFile',
        },
        // Folder rows carry no scmResourceHasHostFile key; depot-only subtrees
        // are filtered in the handler instead of hiding the entry.
        { id: MenuId.ScmResourceFolderContext, group: '4_agent', order: 1 },
      ],
    })
  }

  override async run(
    accessor: ServicesAccessor,
    primaryArg?: unknown,
    selectionArg?: unknown,
  ): Promise<void> {
    // Capture every service before the first await — the accessor dies past it.
    const workspace = accessor.get(IWorkspaceService)
    const uriIdentity = accessor.get(IUriIdentityService)
    const reveal = captureRevealServices(accessor)
    const workspaceFolder = workspace.current?.folder
    const authority = currentRemoteAuthority(workspace.current)
    const entries = collectScmEntries(primaryArg, selectionArg, authority, uriIdentity)
    if (entries.length === 0) return
    await depositResourceRefs(reveal, workspaceFolder, uriIdentity, entries)
  }
}

export const agentContextActions: readonly (new () => Action2)[] = [
  AddSelectionToExistingAgentChatAction,
  AddSelectionToNewAgentChatAction,
  SendCommitToAgentChatAction,
  SendContextToAgentChatAction,
  SendChangelistToAgentChatAction,
  SendExplorerResourceToAgentChatAction,
  SendScmResourceToAgentChatAction,
]
