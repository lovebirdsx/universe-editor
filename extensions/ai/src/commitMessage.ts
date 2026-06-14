/**
 * Commit-message generation. Pulls the commit diff from the git extension, asks
 * the AI model to summarize it, and streams the result back into the SCM commit
 * input box as it arrives. Both reads and write-back go through git extension
 * commands so this plugin never touches SCM state directly.
 */
import { ai, commands, window, workspace, AiMessageRole } from '@universe-editor/extension-api'

const SYSTEM_PROMPT = [
  'You are a commit-message generator. Given a unified git diff, write a single',
  'Conventional Commits message describing the change.',
  'Rules:',
  '- First line: `<type>(<scope>): <subject>`, imperative mood, <= 72 chars, no trailing period.',
  '- Use a type from: feat, fix, docs, style, refactor, perf, test, build, chore.',
  '- Omit the scope if no single scope fits.',
  '- Add a blank line then a concise body ONLY when the change needs explanation.',
  '- Output ONLY the commit message — no code fences, no preamble, no quotes.',
].join('\n')

function buildUserPrompt(diff: string): string {
  return `Generate a commit message for the following diff:\n\n${diff}`
}

function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff
  return `${diff.slice(0, maxChars)}\n\n[diff truncated: ${diff.length - maxChars} more characters omitted]`
}

/** Resolve the model id from config, falling back to the first available model. */
async function resolveModelId(configured: string): Promise<string | undefined> {
  if (configured) return configured
  const models = await ai.getModels()
  return models[0]?.id
}

export async function generateCommitMessage(arg: unknown): Promise<void> {
  const diff = await commands.executeCommand<string>('git.getCommitDiff', arg)
  if (!diff || !diff.trim()) {
    await window.showInformationMessage('No changes to summarize.')
    return
  }

  const cfg = workspace.getConfiguration('ai')
  const configuredModel = await cfg.get('commitMessage.modelId', '')
  const maxDiffChars = await cfg.get('commitMessage.maxDiffChars', 12000)

  const modelId = await resolveModelId(configuredModel)
  if (!modelId) {
    await window.showErrorMessage('No AI model is available. Configure a model first.')
    return
  }

  const response = ai.sendRequest(
    [
      { role: AiMessageRole.System, content: SYSTEM_PROMPT },
      { role: AiMessageRole.User, content: buildUserPrompt(truncateDiff(diff, maxDiffChars)) },
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
