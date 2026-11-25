/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The prop surface shared by every resolvable workbench glyph. Lucide components
 *  accept this superset; the codicon fallback ignores `strokeWidth`.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType, CSSProperties } from 'react'

export interface WorkbenchIconProps {
  // `size` deliberately omits `| undefined`: LucideProps declares it as
  // `size?: string | number`, and exactOptionalPropertyTypes would otherwise
  // reject every Lucide component as a WorkbenchIcon.
  readonly size?: number | string
  readonly strokeWidth?: number | string
  readonly className?: string | undefined
  readonly style?: CSSProperties | undefined
  readonly color?: string | undefined
  readonly 'aria-hidden'?: boolean | 'true' | 'false' | undefined
  readonly 'data-testid'?: string | undefined
}

export type WorkbenchIcon = ComponentType<WorkbenchIconProps>
