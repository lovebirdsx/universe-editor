/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/diagnostics/issueUrl.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ISSUE_URL_BASE, buildIssueUrl } from '../issueUrl.js'

describe('buildIssueUrl', () => {
  it('embeds the markdown body when it fits', () => {
    const url = buildIssueUrl('## 版本\n- app 1.0.0', 'hint')
    expect(url.startsWith(`${ISSUE_URL_BASE}?body=`)).toBe(true)
    expect(decodeURIComponent(url)).toContain('## 版本')
  })

  it('degrades to the paste hint when the body would make the URL too long', () => {
    const url = buildIssueUrl('x'.repeat(10000), '请从剪贴板粘贴')
    expect(url.length).toBeLessThanOrEqual(7500)
    expect(decodeURIComponent(url)).toContain('请从剪贴板粘贴')
    expect(decodeURIComponent(url)).not.toContain('xxxx')
  })
})
