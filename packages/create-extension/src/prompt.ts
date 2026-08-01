/**
 * Interactive prompts (@clack/prompts). Only the missing answers are asked —
 * fully flag-driven invocations never touch the TTY, which keeps the CLI
 * usable from CI and AI agents.
 */
import * as p from '@clack/prompts'
import { ScaffoldError } from './errors.js'
import { validateExtensionName, validatePublisher } from './validate.js'
import type { ScaffoldAnswers } from './placeholders.js'

export interface PartialAnswers {
  readonly name?: string | undefined
  readonly publisher?: string | undefined
  readonly displayName?: string | undefined
  readonly description?: string | undefined
  readonly template?: 'basic' | 'webview' | undefined
}

/** True when every answer that has no default is already provided. */
export function isNonInteractive(
  partial: PartialAnswers,
): partial is PartialAnswers & { name: string; publisher: string; template: 'basic' | 'webview' } {
  return (
    partial.name !== undefined && partial.publisher !== undefined && partial.template !== undefined
  )
}

function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('aborted')
    process.exit(130)
  }
  return value
}

export async function promptForMissing(partial: PartialAnswers): Promise<ScaffoldAnswers> {
  p.intro('create a Universe Editor extension')

  const name =
    partial.name ??
    guard(
      await p.text({
        message: 'extension id',
        placeholder: 'my-extension',
        validate: (v) => validateExtensionName(v) ?? undefined,
      }),
    )
  const publisher =
    partial.publisher ??
    guard(
      await p.text({
        message: 'publisher id (must match your publish token)',
        placeholder: 'acme',
        validate: (v) => validatePublisher(v) ?? undefined,
      }),
    )
  const displayName =
    partial.displayName ??
    (guard(
      await p.text({
        message: 'display name',
        placeholder: name,
      }),
    ) ||
      name)
  const description =
    partial.description ??
    guard(
      await p.text({
        message: 'description (optional)',
        placeholder: '',
      }),
    )
  const template =
    partial.template ??
    guard(
      await p.select({
        message: 'template',
        options: [
          { value: 'basic' as const, label: 'basic', hint: 'a Hello World command' },
          {
            value: 'webview' as const,
            label: 'webview',
            hint: 'a read-only custom-editor preview',
          },
        ],
      }),
    )

  const answers: ScaffoldAnswers = { name, publisher, displayName, description, template }
  const nameError = validateExtensionName(answers.name)
  if (nameError) throw new ScaffoldError(`invalid extension name: ${nameError}`)
  const publisherError = validatePublisher(answers.publisher)
  if (publisherError) throw new ScaffoldError(`invalid publisher: ${publisherError}`)
  return answers
}
