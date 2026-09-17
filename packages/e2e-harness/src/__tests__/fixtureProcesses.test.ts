import { describe, expect, it } from 'vitest'
import { extractUserDataDir } from '../fixtureProcesses.js'

describe('extractUserDataDir', () => {
  it('认 --user-data-dir=<v> 形态（launchApp 与自启 spec 都用它）', () => {
    expect(
      extractUserDataDir(['/app/out/main/index.js', '--user-data-dir=/run/fx/universe-editor-e2e-a1']),
    ).toBe('/run/fx/universe-editor-e2e-a1')
  })

  it('认 --user-data-dir <v> 空格形态', () => {
    expect(extractUserDataDir(['--user-data-dir', '/run/fx/x', '--enable-e2e-probe'])).toBe(
      '/run/fx/x',
    )
  })

  it('多个 --user-data-dir 时取第一个（Electron 也是后者生效，但首个即我们的 fixture）', () => {
    expect(extractUserDataDir(['--user-data-dir=/a', '--user-data-dir=/b'])).toBe('/a')
  })

  it('没有该参数、参数为空数组或 args 缺失都返回 undefined', () => {
    expect(extractUserDataDir(['/app/out/main/index.js'])).toBeUndefined()
    expect(extractUserDataDir([])).toBeUndefined()
    expect(extractUserDataDir(undefined)).toBeUndefined()
  })

  it('空格形态后没有值时返回 undefined', () => {
    expect(extractUserDataDir(['--user-data-dir'])).toBeUndefined()
  })
})
