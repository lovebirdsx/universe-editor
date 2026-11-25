import { Activity, FolderTree } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { CONTAINER_ICON_MAP } from '../containerIcons.js'
import { resolveActivityIcon } from '../../activitybar/icon-map.js'

describe('CONTAINER_ICON_MAP', () => {
  it('resolves `pulse`, the trusted-view icon used in the docs', () => {
    // docs/extension-dev/zh-CN/contribution-points.md uses `$(pulse)` as a
    // trusted view title icon. The curated entry keeps it on Lucide Activity;
    // without it the codicon font would render it instead.
    expect(CONTAINER_ICON_MAP['pulse']).toBe(Activity)
    expect(resolveActivityIcon('pulse')).toBe(Activity)
  })

  it('renders any other registered codicon instead of falling back', () => {
    expect(resolveActivityIcon('folder')).not.toBe(FolderTree)
  })

  it('keeps every curated container id on its Lucide glyph', () => {
    for (const [id, icon] of Object.entries(CONTAINER_ICON_MAP)) {
      expect(resolveActivityIcon(id), id).toBe(icon)
    }
  })

  it('only falls back to the Explorer glyph for values that are not icon references', () => {
    expect(resolveActivityIcon('acme.editor-service.nope')).toBe(FolderTree)
  })
})
