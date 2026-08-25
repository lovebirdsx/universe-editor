/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Turns a probe result into a message. verifyProvider runs in the main process,
 *  whose locale is resolved from its own settings read — localizing there would
 *  pin the text to main's language rather than the window's. So the probe returns
 *  a code and this is where it becomes words.
 *--------------------------------------------------------------------------------------------*/

import { localize, type AiProviderVerifyResult } from '@universe-editor/platform'

export function verifyFailureMessage(result: AiProviderVerifyResult): string {
  const status = result.status !== undefined ? String(result.status) : ''
  switch (result.code) {
    case 'noProvider':
      return localize('ai.verify.noProvider', 'No provider is registered for this protocol.')
    case 'unreachable':
      return localize('ai.verify.unreachable', 'Could not connect to the endpoint.')
    case 'timeout':
      return localize('ai.verify.timeout', 'The endpoint did not respond in time.')
    case 'unauthorized':
      return localize(
        'ai.verify.unauthorized',
        'Authentication failed ({status}). Check the API key.',
        { status },
      )
    case 'serverError':
      return localize('ai.verify.serverError', 'The endpoint returned a server error ({status}).', {
        status,
      })
    case 'httpError':
      return localize(
        'ai.verify.httpError',
        'The endpoint returned an unexpected status ({status}).',
        { status },
      )
    case 'noModels':
      return localize('ai.verify.noModels', 'The endpoint responded but no models are available.')
    default:
      return localize('ai.verify.failed', 'Connection failed.')
  }
}
