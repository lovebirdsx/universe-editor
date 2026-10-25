/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ResourcePreviewButton — the shared hover "Open Preview" affordance for file
 *  rows (explorer / SCM / session changes / graphs). Renders nothing when the
 *  resource has no preview flavor, so callers can stay unconditional. The
 *  button itself is always rendered; whether it is *visible* is the consumer's
 *  row CSS (`.row:hover .actions { display:flex }`), which keeps memoised row
 *  components free of hover state.
 *--------------------------------------------------------------------------------------------*/

import { memo } from 'react'
import { Eye } from 'lucide-react'
import { IInstantiationService, localize, type URI } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { resolveOpenTarget } from '../../services/editor/openTarget.js'
import { previewLanguageForResource } from '../../services/resourcePreview/resourcePreviewSupport.js'
import { openResourcePreview } from '../../services/resourcePreview/openResourcePreview.js'
import styles from './ResourcePreviewButton.module.css'

const TITLE = localize('resourcePreview.openPreview', 'Open Preview')

export const ResourcePreviewButton = memo(function ResourcePreviewButton({
  resource,
  testId,
}: {
  readonly resource: URI
  /** Stable hook for e2e / tests; omitted unless a caller needs one. */
  readonly testId?: string
}) {
  const inst = useService(IInstantiationService)
  if (previewLanguageForResource(resource) === undefined) return null
  return (
    <button
      type="button"
      className={styles['actionButton']}
      data-tooltip={TITLE}
      aria-label={TITLE}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      onClick={(e) => {
        e.stopPropagation()
        const target = resolveOpenTarget(e)
        inst.invokeFunction((accessor) => openResourcePreview(accessor, resource, target))
      }}
    >
      <Eye size={16} strokeWidth={1.6} />
    </button>
  )
})
