/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared window zoom math for the workspace host service and auxiliary windows.
 *--------------------------------------------------------------------------------------------*/

// Chromium's zoom level is logarithmic: each unit is a ~20% factor. Clamp to the
// range webFrame accepts so repeated presses can't run off-scale.
export const ZOOM_STEP = 1
export const ZOOM_MIN = -8
export const ZOOM_MAX = 9

const ZOOM_FACTOR_BASE = 1.2

export function clampZoomLevel(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))
}

// window.zoomLevel is stored as a display factor (1 = 100%, 1.25 = 125%) because
// that's what users think in; Chromium's zoom level is logarithmic.
export function zoomFactorToLevel(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 0
  return Math.log(factor) / Math.log(ZOOM_FACTOR_BASE)
}

export function zoomLevelToFactor(level: number): number {
  return Math.pow(ZOOM_FACTOR_BASE, level)
}
