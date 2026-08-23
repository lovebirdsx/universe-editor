/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Official vendor endpoints per wire protocol, plus the pure test used to tell
 *  an official endpoint (write `ANTHROPIC_API_KEY`) from a gateway (write
 *  `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`). Shared by renderer and main.
 *--------------------------------------------------------------------------------------------*/

import type { AiWireProtocol } from '@universe-editor/platform'

export const OFFICIAL_BASE_URLS: Readonly<Partial<Record<AiWireProtocol, readonly string[]>>> = {
  'anthropic-messages': ['https://api.anthropic.com'],
  'openai-chat': ['https://api.openai.com/v1'],
  'openai-responses': ['https://api.openai.com/v1'],
}

/** A missing baseUrl means "the vendor default", which is official. */
export function isOfficialEndpoint(protocol: AiWireProtocol, baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return true
  const normalized = normalizeBaseUrl(baseUrl)
  return (OFFICIAL_BASE_URLS[protocol] ?? []).some(
    (official) => normalizeBaseUrl(official) === normalized,
  )
}

/**
 * Compare hosts only: strip trailing slashes and a trailing `/v1` path segment
 * (the OpenAI endpoints are usually spelled with it), lowercase so host casing is
 * ignored.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '')
}
