/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  officialEndpoints: telling an official vendor endpoint apart from a gateway,
 *  ignoring trailing slashes, host casing, and a trailing /v1 path segment.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isOfficialEndpoint } from '../officialEndpoints.js'

describe('isOfficialEndpoint', () => {
  it('treats an undefined baseUrl as the official default', () => {
    expect(isOfficialEndpoint('anthropic-messages', undefined)).toBe(true)
    expect(isOfficialEndpoint('openai-chat', undefined)).toBe(true)
  })

  it('matches the anthropic official endpoint', () => {
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.anthropic.com')).toBe(true)
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.anthropic.com/')).toBe(true)
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.anthropic.com/v1')).toBe(true)
  })

  it('matches the openai official endpoint across both openai protocols', () => {
    expect(isOfficialEndpoint('openai-chat', 'https://api.openai.com/v1')).toBe(true)
    expect(isOfficialEndpoint('openai-responses', 'https://api.openai.com/v1')).toBe(true)
    expect(isOfficialEndpoint('openai-chat', 'https://api.openai.com')).toBe(true)
  })

  it('ignores host casing and trailing slashes', () => {
    expect(isOfficialEndpoint('anthropic-messages', 'HTTPS://API.ANTHROPIC.COM')).toBe(true)
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.anthropic.com///')).toBe(true)
  })

  it('rejects a gateway endpoint', () => {
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.acme.example/v1')).toBe(false)
    expect(isOfficialEndpoint('openai-chat', 'https://api.moonshot.cn/anthropic')).toBe(false)
  })

  it('rejects a gateway that only suffixes the official host', () => {
    expect(isOfficialEndpoint('anthropic-messages', 'https://api.anthropic.com.evil.example')).toBe(
      false,
    )
  })

  it('rejects an empty string baseUrl', () => {
    expect(isOfficialEndpoint('anthropic-messages', '')).toBe(false)
  })

  it('returns false for protocols with no official endpoint', () => {
    expect(isOfficialEndpoint('ollama', 'http://127.0.0.1:11434')).toBe(false)
  })
})
