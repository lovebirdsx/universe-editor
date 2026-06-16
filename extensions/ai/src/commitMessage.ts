/**
 * Commit-message generation. Pulls structured commit context from the git
 * extension (per-file diffs plus recent commit subjects for style), asks the AI
 * model to summarize it in this repository's style, and streams the result back
 * into the SCM commit input box as it arrives. Both reads and write-back go
 * through git extension commands so this plugin never touches SCM state directly.
 */
import { ai, commands, window, workspace, AiMessageRole } from '@universe-editor/extension-api'

interface CommitGenContext {
  repoName: string
  branch?: string
  recentCommits: string[]
  userCommits: string[]
  files: { path: string; diff: string }[]
}

const SYSTEM_PROMPT = [
  'You are an AI programming assistant that writes the single most appropriate git',
  'commit message for a set of code changes. You understand the intent behind a',
  "change and produce concise, clear messages that follow this repository's own",
  'conventions.',
  '',
  'Think step by step:',
  '1. Analyze the CODE CHANGES to understand what was modified.',
  '2. Identify the purpose of the change — answer *why* it was made, using the',
  '   recent commits as a hint.',
  '3. Study the recent repository and author commits to learn their format and',
  '   style, including language, subject length, capitalization, prefixes, mood,',
  '   and level of detail. If recent commits are mostly in Chinese, write the',
  '   commit message in Chinese; if they are mostly in English, write it in',
  '   English. If the language is mixed, follow the most recent consistent',
  '   pattern. Ignore refs, tags, author names and other metadata, and never copy',
  '   their content.',
  '4. Write a thoughtful, concise commit message that follows the conventions you',
  '   observed. Match the typical length and style of recent commits as closely',
  '   as possible while still accurately describing the current change.',
  '5. Remove any issue references, tags, author names or other metadata.',
  '',
  'Output ONLY the commit message itself — no code fences, no preamble, no',
  'explanation, no surrounding quotes.',
].join('\n')

function formatSubjects(subjects: string[]): string {
  return subjects.map((s) => `- ${s}`).join('\n')
}

/** Join per-file diffs, trimming the tail once the combined budget is spent. */
function formatFileDiffs(files: { path: string; diff: string }[], budget: number): string {
  const sections: string[] = []
  let used = 0
  let dropped = 0
  for (const file of files) {
    if (used >= budget) {
      dropped++
      continue
    }
    let diff = file.diff
    const remaining = budget - used
    if (diff.length > remaining) diff = `${diff.slice(0, remaining)}\n[diff truncated]`
    used += diff.length
    sections.push(`### ${file.path}\n${diff}`)
  }
  let out = sections.join('\n\n')
  if (dropped > 0) out += `\n\n[${dropped} more file(s) omitted to fit the size budget]`
  return out
}

function buildUserPrompt(ctx: CommitGenContext, budget: number, instructions: string): string {
  const parts: string[] = [`Repository: ${ctx.repoName}`]
  if (ctx.branch) parts.push(`Branch: ${ctx.branch}`)
  if (ctx.recentCommits.length > 0) {
    parts.push(
      `\nRecent repository commits (for style reference only — do not copy):\n${formatSubjects(ctx.recentCommits)}`,
    )
  }
  if (ctx.userCommits.length > 0) {
    parts.push(
      `\nRecent commits by you (for style reference only):\n${formatSubjects(ctx.userCommits)}`,
    )
  }
  parts.push(`\nCODE CHANGES:\n\n${formatFileDiffs(ctx.files, budget)}`)
  if (instructions.trim()) parts.push(`\nAdditional instructions:\n${instructions.trim()}`)
  parts.push(
    '\nRemember: output a single commit message that follows the style of the recent commits without copying them. Do not wrap it in a code block.',
  )
  return parts.join('\n')
}

/** Resolve the model id: explicit config → active model → first available. */
async function resolveModelId(configured: string): Promise<string | undefined> {
  if (configured) return configured
  const active = await ai.getActiveModelId()
  if (active) return active
  const models = await ai.getModels()
  return models[0]?.id
}

export async function generateCommitMessage(arg: unknown): Promise<void> {
  const ctx = await commands.executeCommand<CommitGenContext | undefined>(
    'git.getCommitGenerationContext',
    arg,
  )
  if (!ctx || ctx.files.length === 0) {
    await window.showInformationMessage('No changes to summarize.')
    return
  }

  const cfg = workspace.getConfiguration('ai')
  const configuredModel = await cfg.get('commitMessage.modelId', '')
  const maxDiffChars = await cfg.get('commitMessage.maxDiffChars', 12000)
  const instructions = await cfg.get('commitMessage.instructions', '')

  const modelId = await resolveModelId(configuredModel)
  if (!modelId) {
    await window.showErrorMessage('No AI model is available. Configure a model first.')
    return
  }

  const response = ai.sendRequest(
    [
      { role: AiMessageRole.System, content: SYSTEM_PROMPT },
      { role: AiMessageRole.User, content: buildUserPrompt(ctx, maxDiffChars, instructions) },
    ],
    { modelId, temperature: 0.2 },
  )

  let message = ''
  let pending = ''
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    flushTimer = undefined
    if (!pending) return
    message += pending
    pending = ''
    void commands.executeCommand('git.setCommitMessage', arg, message.trimStart())
  }

  try {
    for await (const chunk of response.stream) {
      if (chunk.type !== 'text') continue
      pending += chunk.value
      if (!flushTimer) flushTimer = setTimeout(flush, 60)
    }
    await response.result
  } catch (err) {
    response.cancel()
    await window.showErrorMessage(
      `Failed to generate commit message: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  } finally {
    if (flushTimer) clearTimeout(flushTimer)
  }

  flush()
  if (!message.trim()) await window.showWarningMessage('The model returned an empty message.')
}
