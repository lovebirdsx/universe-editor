/**
 * AI Assist extension entry. Focuses on AI-assisted editor features. The first
 * feature generates a commit message from local changes and streams it into the
 * SCM commit input box.
 *
 * `activate` runs inside the trusted extension host, which injects the `ai`
 * namespace. Commands are registered on `context.subscriptions` for teardown.
 */
import { commands, type ExtensionContext } from '@universe-editor/extension-api'
import { generateCommitMessage } from './commitMessage.js'

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('ai.generateCommitMessage', (arg) => generateCommitMessage(arg)),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions handle teardown.
}
