/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  AcpSessionCreateProfiler,
  formatSessionCreateProfile,
} from '../acpSessionCreateProfiler.js'

describe('AcpSessionCreateProfiler', () => {
  it('records steps in order and completes on end()', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    handle.step('willConnect')
    handle.step('didConnect')
    const profile = handle.end()

    expect(profile.agentId).toBe('codex')
    expect(profile.steps.map((s) => s.name)).toEqual(['willConnect', 'didConnect'])
    expect(profile.steps[0]!.at).toBeGreaterThanOrEqual(profile.startedAt)
    expect(profile.endedAt).toBeGreaterThanOrEqual(profile.steps[1]!.at)
    expect(profile.failed).toBeUndefined()
    expect(profile.pooledConnection).toBe(false)
    expect(profiler.lastProfiles()).toHaveLength(1)
  })

  it('fail() records the failure message', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    handle.step('willNewSession')
    const profile = handle.fail('boom')
    expect(profile.failed).toBe('boom')
    expect(profile.endedAt).toBeDefined()
  })

  it('markPooled tags the profile; step() after end() is a no-op', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    handle.markPooled()
    const profile = handle.end()
    handle.step('late')
    expect(profile.pooledConnection).toBe(true)
    expect(profile.steps).toHaveLength(0)
  })

  it('end() is idempotent and returns the same profile', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    const first = handle.end()
    const second = handle.end()
    expect(second).toBe(first)
    expect(profiler.lastProfiles()).toHaveLength(1)
  })

  it('keeps only the most recent 5 profiles', () => {
    const profiler = new AcpSessionCreateProfiler()
    for (let i = 0; i < 7; i++) profiler.begin('codex').end()
    expect(profiler.lastProfiles()).toHaveLength(5)
  })

  it('step timestamps are monotonically non-decreasing', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    handle.step('a')
    handle.step('b')
    handle.step('c')
    const profile = handle.end()
    const ats = profile.steps.map((s) => s.at)
    expect([...ats].sort((x, y) => x - y)).toEqual(ats)
  })
})

describe('formatSessionCreateProfile', () => {
  it('renders only the segments present, plus total', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('codex')
    handle.step('willConnect')
    handle.step('didConnect')
    handle.step('willNewSession')
    const profile = handle.end()
    const line = formatSessionCreateProfile(profile)
    expect(line).toMatch(/^acp\.session_create agent=codex pooled=false /)
    expect(line).toContain('connect=')
    expect(line).not.toContain('newSession=')
    expect(line).not.toContain('binary=')
    expect(line).toMatch(/total=\d+ms$/)
  })

  it('renders the failure message', () => {
    const profiler = new AcpSessionCreateProfiler()
    const handle = profiler.begin('claude-code')
    const profile = handle.fail('spawn died')
    expect(formatSessionCreateProfile(profile)).toContain('failed=spawn died')
  })
})
