/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/configurationResolver/configurationResolverExpression.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ConfigurationResolverExpression } from '../../configurationResolver/configurationResolverExpression.js'
import type { HostPlatform } from '../../host/hostService.js'

function resolveString(
  input: string,
  values: Record<string, string>,
  platform: HostPlatform = 'linux',
): string {
  const expr = ConfigurationResolverExpression.parse(input, platform)
  for (const r of expr.unresolved()) {
    const v =
      values[r.id] ??
      values[r.name] ??
      (r.arg !== undefined ? values[`${r.name}:${r.arg}`] : undefined)
    if (v !== undefined) expr.resolve(r, v)
  }
  return expr.toObject()
}

describe('ConfigurationResolverExpression', () => {
  it('parses a bare ${name}', () => {
    const expr = ConfigurationResolverExpression.parse('${workspaceFolder}', 'linux')
    const found = [...expr.unresolved()]
    expect(found).toHaveLength(1)
    expect(found[0]!.name).toBe('workspaceFolder')
    expect(found[0]!.arg).toBeUndefined()
  })

  it('splits ${name:arg} on the first colon only', () => {
    const expr = ConfigurationResolverExpression.parse('${config:editor.fontSize}', 'linux')
    const [r] = [...expr.unresolved()]
    expect(r!.name).toBe('config')
    expect(r!.arg).toBe('editor.fontSize')
  })

  it('keeps args containing spaces intact (brace-counting, not regex)', () => {
    const expr = ConfigurationResolverExpression.parse('${env:MY VAR}', 'linux')
    const [r] = [...expr.unresolved()]
    expect(r!.name).toBe('env')
    expect(r!.arg).toBe('MY VAR')
  })

  it('substitutes and returns the resolved string', () => {
    expect(resolveString('${workspaceFolder}/src', { workspaceFolder: '/home/x' })).toBe(
      '/home/x/src',
    )
  })

  it('leaves unresolved variables intact', () => {
    expect(resolveString('${unknownVar}/src', {})).toBe('${unknownVar}/src')
  })

  it('resolves multiple occurrences of the same variable', () => {
    expect(resolveString('${a}-${a}', { a: 'X' })).toBe('X-X')
  })

  it('re-parses freshly substituted text so nested variables resolve in one pass', () => {
    // ${a} -> "${b}", ${b} -> "done"
    const expr = ConfigurationResolverExpression.parse('${a}', 'linux')
    const map: Record<string, string> = { '${a}': '${b}', '${b}': 'done' }
    for (const r of expr.unresolved()) {
      expr.resolve(r, map[r.id]!)
    }
    expect(expr.toObject()).toBe('done')
  })

  it('applies platform-specific keys (windows) during parse', () => {
    const expr = ConfigurationResolverExpression.parse(
      { cwd: '${workspaceFolder}', windows: { cwd: 'C:/win' } } as Record<string, unknown>,
      'win32',
    )
    // windows override replaces cwd; no unresolved ${workspaceFolder} remains
    expect([...expr.unresolved()]).toHaveLength(0)
    expect(expr.toObject()).toEqual({ cwd: 'C:/win' })
  })

  it('applies platform-specific keys (linux picks base, drops platform buckets)', () => {
    const expr = ConfigurationResolverExpression.parse(
      { cwd: '/base', windows: { cwd: 'C:/win' } } as Record<string, unknown>,
      'linux',
    )
    expect(expr.toObject()).toEqual({ cwd: '/base' })
  })

  it('does not treat an unterminated ${ as a variable', () => {
    const expr = ConfigurationResolverExpression.parse('${unterminated', 'linux')
    expect([...expr.unresolved()]).toHaveLength(0)
    expect(expr.toObject()).toBe('${unterminated')
  })
})
