/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumb picker geometry, mirroring VSCode's breadcrumbsPicker layout.
 *--------------------------------------------------------------------------------------------*/

export const BREADCRUMB_PICKER_ATTRIBUTE = 'data-breadcrumb-picker'

export interface BreadcrumbPickerAnchor {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface BreadcrumbPickerViewport {
  readonly width: number
  readonly height: number
}

export interface BreadcrumbPickerLayout {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly maxHeight: number
}

export function computeBreadcrumbPickerLayout(
  anchor: BreadcrumbPickerAnchor,
  viewport: BreadcrumbPickerViewport,
): BreadcrumbPickerLayout {
  const maxInnerWidth = Math.max(0, viewport.width - 8)
  const width = Math.min(maxInnerWidth, Math.max(240, maxInnerWidth / 4.17))
  const y = anchor.top + anchor.height
  let maxHeight = Math.min(viewport.height * 0.7, 300)
  if (y + maxHeight >= viewport.height) maxHeight = Math.max(0, viewport.height - y - 30)
  return { x: anchor.left, y, width, maxHeight }
}
