/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared "resolve the target agent chat and reveal it" helpers for
 *  agent-facing entry points (Action2 runs, monaco code-action commands, ...).
 *  Action2 callers snapshot the accessor via captureRevealServices before
 *  their first await; non-action callers (contributions) hand-build the same
 *  RevealServices from constructor-injected services.
 *
 *  Three target strategies live here, one per entry point:
 *    - resolveExistingChatTarget — "Add Selection to Existing Agent Chat":
 *      the user may not care which chat, but must not be second-guessed. Zero
 *      chats creates one (the command would otherwise be a no-op), one chat is
 *      used silently, several prompt a picker.
 *    - createChatTarget — "Add Selection to New Agent Chat": always a new one.
 *    - resolveActiveOrNewSession — Git Graph's "Send to Agent Chat", where the
 *      subject is the commit under the cursor and the destination is simply
 *      "the chat I am in"; a picker there would turn one gesture into three.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import type { IAcpSession } from '../services/acp/session/acpSessionModel.js'
import { IAcpAgentRegistry, agentIconId } from '../services/acp/acpAgentRegistry.js'
import {
  computeSessionDisplayStatus,
  isResidentLive,
} from '../services/acp/session/acpSessionStatus.js'
import { revealSessionChat } from '../services/acp/session/revealSessionChat.js'
import { sessionDirectoryName } from './_agentShared.js'

// Services revealChat / resolveExistingChatTarget need, snapshotted while the
// accessor is still valid (i.e. before run's first await).
export interface RevealServices {
  readonly sessions: IAcpSessionService
  readonly registry: IAcpAgentRegistry
  readonly widgets: IAcpChatWidgetService
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
}

export function captureRevealServices(accessor: ServicesAccessor): RevealServices {
  return {
    sessions: accessor.get(IAcpSessionService),
    registry: accessor.get(IAcpAgentRegistry),
    widgets: accessor.get(IAcpChatWidgetService),
    groups: accessor.get(IEditorGroupsService),
    inst: accessor.get(IInstantiationService),
  }
}

/**
 * Chats a selection can actually be delivered to: resident-live (a dormant
 * session still counts — it wakes on send) and not a read-only preview of
 * another worktree, whose sendPrompt is a no-op and would swallow the deposit.
 *
 * Side tasks qualify: they are real, sendable chats in this window, even though
 * the sessions list nests them under their parent instead of listing them flat.
 */
export function listChatTargets(sessions: IAcpSessionService): readonly IAcpSession[] {
  return sessions.sessions.get().filter(canReceiveContext)
}

// Depositing into anything else would queue into an inbox whose PromptInput can
// never mount (read-only preview) or never carry a prompt (closed for good).
function canReceiveContext(session: IAcpSession): boolean {
  return !session.readOnly && isResidentLive(session)
}

/** Open a brand-new session for the context to land in. */
export function createChatTarget(services: RevealServices): Promise<IAcpSession> {
  return services.sessions.createSession(services.registry.defaultAgentId())
}

/**
 * Pick the chat an explicitly-attached context should land in. One candidate is
 * used without asking; an empty list falls back to a new session so the command
 * is never a silent no-op. `undefined` means the user dismissed the picker — a
 * picked chat that stopped being deliverable in the meantime (closed, or turned
 * into a read-only preview) falls back to a new session instead, since silently
 * dropping the selection the user just aimed would be the worse surprise.
 */
export async function resolveExistingChatTarget(
  services: RevealServices,
  quickInput: IQuickInputService,
): Promise<IAcpSession | undefined> {
  const candidates = listChatTargets(services.sessions)
  const [first, ...rest] = candidates
  if (!first) return createChatTarget(services)
  if (rest.length === 0) return first

  const ordered = withActiveFirst(candidates, services.sessions.activeSession.get()?.id)
  const items = chatTargetPickItems(ordered)
  const activeItemId = ordered[0]?.id
  const pick = await quickInput.pick<ChatTargetPickItem>(items, {
    placeholder: localize(
      'agent.addSelection.pickTarget',
      'Choose an Agent chat to add the selection to',
    ),
    matchOnDescription: true,
    ...(activeItemId !== undefined ? { activeItemId } : {}),
  })
  if (!pick) return undefined
  const picked = services.sessions.getById(pick.sessionId)
  return picked && canReceiveContext(picked) ? picked : createChatTarget(services)
}

/**
 * Resolve the target session the hands-free way: the active one, else create a
 * fresh session so the context always has a home even from a cold start.
 */
export async function resolveActiveOrNewSession(services: RevealServices) {
  const active = services.sessions.activeSession.get()
  if (active) return active
  return services.sessions.createSession(services.registry.defaultAgentId())
}

// Make the target session's chat visible and focus its input so the user sees
// the freshly-attached chips and can keep typing. Focus is best-effort (the
// widget may still be mounting; the inbox drain covers that case).
export async function revealChat(services: RevealServices, sessionId: string): Promise<void> {
  revealSessionChat(services, sessionId, services.sessions.getById(sessionId))
}

interface ChatTargetPickItem extends IQuickPickItem {
  readonly sessionId: string
}

// The active session leads (it is the likeliest target, and a just-created one
// is almost always active); the rest follow newest-first, since `sessions` is
// in creation order. So the default highlight lands on "current, else newest".
function withActiveFirst(
  sessions: readonly IAcpSession[],
  activeId: string | undefined,
): readonly IAcpSession[] {
  const active = activeId === undefined ? undefined : sessions.find((s) => s.id === activeId)
  const rest = sessions.filter((s) => s !== active).reverse()
  return active ? [active, ...rest] : rest
}

// `detail` is not rendered by the quick input row, so the disambiguating cwd
// goes in `description`. No `id` in the pick options: that would switch the
// picker into MRU mode and reorder our explicitly-chosen sequence.
function chatTargetPickItems(sessions: readonly IAcpSession[]): readonly ChatTargetPickItem[] {
  return sessions.map((session) => {
    const directory = sessionDirectoryName(session.cwd)
    return {
      id: session.id,
      iconId: agentIconId(session.agentId),
      label: session.title,
      ...(directory !== undefined ? { description: directory } : {}),
      statusIconId: computeSessionDisplayStatus(session),
      sessionId: session.id,
    }
  })
}
