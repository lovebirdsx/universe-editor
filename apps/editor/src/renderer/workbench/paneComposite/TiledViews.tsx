/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tiled content area for the Panel: every view in the active container is kept
 *  mounted (so terminal/output processes survive tab switches); CSS hides the
 *  inactive ones.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import type { IViewDescriptor } from '@universe-editor/platform'
import styles from './PaneComposite.module.css'

interface Props {
  views: readonly IViewDescriptor[]
  resolve: (componentKey: string) => ComponentType | undefined
}

export function TiledViews({ views, resolve }: Props) {
  return (
    <div className={styles['content']}>
      {views.map((v) => {
        const Component = resolve(v.componentKey)
        return Component ? (
          <div key={v.id} data-view-id={v.id} className={styles['viewBody'] ?? ''}>
            <Component />
          </div>
        ) : null
      })}
    </div>
  )
}
