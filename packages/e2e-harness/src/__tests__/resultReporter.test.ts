import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
import { afterEach, describe, expect, it } from 'vitest'
import E2EResultReporter from '../resultReporter.js'

const ENV_KEY = 'UNIVERSE_E2E_RESULT_FILE'
const saved = process.env[ENV_KEY]

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe('E2EResultReporter', () => {
  it('writes the run status to UNIVERSE_E2E_RESULT_FILE', () => {
    const dir = mkTempDir('ue-e2e-result-test-')
    const file = join(dir, 'result.json')
    process.env[ENV_KEY] = file

    new E2EResultReporter().onEnd({ status: 'passed' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ status: 'passed' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('recreates the sentinel dir if a cleanup pass removed it', () => {
    // Regression: a pre-spawn cleanup removed the runner's sentinel dir, the write
    // threw ENOENT and a green pass was reported as "no Playwright result".
    const dir = mkTempDir('ue-e2e-result-test-')
    const file = join(dir, 'result.json')
    process.env[ENV_KEY] = file
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)

    new E2EResultReporter().onEnd({ status: 'passed' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ status: 'passed' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing when the env seam is unset', () => {
    const dir = mkTempDir('ue-e2e-result-test-')
    const file = join(dir, 'result.json')
    writeFileSync(file, 'untouched')
    delete process.env[ENV_KEY]

    new E2EResultReporter().onEnd({ status: 'failed' })

    expect(readFileSync(file, 'utf8')).toBe('untouched')
    rmSync(dir, { recursive: true, force: true })
  })
})
