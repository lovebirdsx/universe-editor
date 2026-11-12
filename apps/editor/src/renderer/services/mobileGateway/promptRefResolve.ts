/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Second-step resolution for the phone's `#` panel. `commit` lists the selected Git
 *  repo's history (loaded through the same serialized git-graph path as the desktop
 *  picker); `chatContext` re-runs an extension provider's own picker on the PC and
 *  returns the accepted item. Both produce the final wire suggestion the phone inserts
 *  and then echoes back on send.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto } from '@universe-editor/extensions-common'
import {
  absolutePathToWorkspaceUri,
  type ICommandService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import {
  clampText,
  isValidCommitHash,
  MAX_PROMPT_REF_COMMIT_TEXT_LENGTH,
  MAX_PROMPT_REF_DESCRIPTION_LENGTH,
  MAX_PROMPT_REF_LABEL_LENGTH,
  MAX_PROMPT_REF_TEXT_LENGTH,
  type MobilePromptRefSuggestion,
} from '@universe-editor/mobile-protocol'
import { relativeTime } from '../../relativeTime.js'
import { chatContextItemToRef } from '../acp/promptRef.js'
import { commitLabel, loadRepoCommits, resolveGitRepoRoot } from '../acp/commitRef.js'
import type { IChatContextService } from '../extensions/ChatContextService.js'
import type { IScmService } from '../extensions/ScmService.js'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const UNSAFE_MULTILINE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function sanitizeSingleLine(value: string): string {
  return value.replace(CONTROL_CHARS, ' ')
}

function sanitizeMultiline(value: string): string {
  return value.replace(UNSAFE_MULTILINE_CHARS, ' ')
}

function wireLabel(value: string): string | undefined {
  const label = clampText(sanitizeSingleLine(value), MAX_PROMPT_REF_LABEL_LENGTH)
  return label.length > 0 ? label : undefined
}

function wireDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const description = clampText(sanitizeSingleLine(value), MAX_PROMPT_REF_DESCRIPTION_LENGTH)
  return description.length > 0 ? description : undefined
}

function commitSuggestion(
  commit: GitGraphCommitDto,
  repoUri: string,
): MobilePromptRefSuggestion | undefined {
  if (!isValidCommitHash(commit.hash)) return undefined
  const message = sanitizeSingleLine(commit.message)
  const text = clampText(message, MAX_PROMPT_REF_COMMIT_TEXT_LENGTH)
  if (text.length === 0) return undefined
  const description = wireDescription(
    `${sanitizeSingleLine(commit.author)} · ${relativeTime(commit.date * 1000)}`,
  )
  return {
    kind: 'commit',
    label: commitLabel(commit.hash, message),
    uri: repoUri,
    commitHash: commit.hash,
    text,
    ...(description !== undefined ? { description } : {}),
  }
}

export interface PromptRefResolverDeps {
  readonly commands: ICommandService
  readonly scm: IScmService
  readonly workspace: IWorkspaceService
  readonly chatContext: IChatContextService
}

export class MobilePromptRefResolver {
  constructor(private readonly _deps: PromptRefResolverDeps) {}

  async resolveCommit(limit: number): Promise<readonly MobilePromptRefSuggestion[]> {
    const root = resolveGitRepoRoot(this._deps.scm)
    if (root === undefined) return []
    const commits = await loadRepoCommits(this._deps.commands, root, limit)
    const repoUri = absolutePathToWorkspaceUri(
      root,
      this._deps.workspace.current?.folder,
    ).toString()
    if (repoUri.length === 0) return []
    const entries: MobilePromptRefSuggestion[] = []
    for (const commit of commits) {
      if (entries.length >= limit) break
      const entry = commitSuggestion(commit, repoUri)
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  async resolveChatContext(
    handle: number,
    query: string,
    expectedLabel: string,
    sessionDir?: string,
  ): Promise<MobilePromptRefSuggestion | undefined> {
    const provider = this._deps.chatContext
      .getProviders()
      .find((entry) => entry.handle === handle)?.provider
    if (provider === undefined || wireLabel(provider.label) !== expectedLabel) return undefined
    // Strict variant: a picker failure must surface on the phone as a failed
    // second step, not as a silent "user cancelled" close.
    const item = await this._deps.chatContext.resolveItemOrThrow(
      handle,
      query,
      sessionDir !== undefined ? { sessionDir } : undefined,
    )
    if (item === undefined) return undefined
    const ref = chatContextItemToRef(item)
    const label = wireLabel(ref.label)
    if (label === undefined) return undefined
    const rawText = sanitizeMultiline(ref.meta?.text ?? '')
    if (rawText.trim().length === 0) return undefined
    const text = clampText(rawText, MAX_PROMPT_REF_TEXT_LENGTH)
    if (text.length !== rawText.length) {
      console.warn(`[mobileGateway] chatContext text truncated (handle=${handle})`)
    }
    const description = wireDescription(provider.description ?? provider.label)
    return {
      kind: 'chatContext',
      label,
      uri: '',
      text,
      ...(description !== undefined ? { description } : {}),
    }
  }
}
