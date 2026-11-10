/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-connection widening for trusted devices. The renderer bridge always
 *  publishes the conservative projection (high-risk options disabled), so the
 *  gateway re-enables exactly those options for a device the PC marked trusted.
 *  Functions return the original reference when nothing changes and never
 *  mutate their input: one event object is shared by every subscriber.
 *--------------------------------------------------------------------------------------------*/

import {
  isHighRiskConfigValue,
  isHighRiskPermissionOption,
  type MobileConfigOption,
  type MobilePendingPermission,
  type MobileSessionEvent,
  type MobileSessionSnapshot,
} from '@universe-editor/mobile-protocol'

export function widenConfigOptionForTrust(option: MobileConfigOption): MobileConfigOption {
  if (option.type !== 'select' || option.options === undefined) return option
  let changed = false
  const options = option.options.map((value) => {
    if (value.allowedOnMobile || !isHighRiskConfigValue(value.value)) return value
    changed = true
    return { ...value, allowedOnMobile: true }
  })
  if (!changed) return option
  return {
    ...option,
    allowedOnMobile: options.some((value) => value.allowedOnMobile),
    options,
  }
}

export function widenPermissionForTrust(
  permission: MobilePendingPermission,
): MobilePendingPermission {
  let changed = false
  const options = permission.options.map((option) => {
    if (option.allowedOnMobile || !isHighRiskPermissionOption(option)) return option
    changed = true
    return { ...option, allowedOnMobile: true }
  })
  if (!changed) return permission
  return { ...permission, options }
}

export function widenSnapshotForTrust(snapshot: MobileSessionSnapshot): MobileSessionSnapshot {
  let changed = false
  const configOptions = snapshot.configOptions.map((option) => {
    const widened = widenConfigOptionForTrust(option)
    if (widened !== option) changed = true
    return widened
  })
  let pendingPermission = snapshot.pendingPermission
  if (pendingPermission !== undefined) {
    const widened = widenPermissionForTrust(pendingPermission)
    if (widened !== pendingPermission) {
      changed = true
      pendingPermission = widened
    }
  }
  if (!changed) return snapshot
  return {
    ...snapshot,
    configOptions,
    ...(pendingPermission !== undefined ? { pendingPermission } : {}),
  }
}

export function widenEventForTrust(event: MobileSessionEvent): MobileSessionEvent {
  switch (event.type) {
    case 'config_options_snapshot': {
      let changed = false
      const options = event.options.map((option) => {
        const widened = widenConfigOptionForTrust(option)
        if (widened !== option) changed = true
        return widened
      })
      return changed ? { ...event, options } : event
    }
    case 'permission_upsert': {
      const permission = widenPermissionForTrust(event.permission)
      return permission === event.permission ? event : { ...event, permission }
    }
    default:
      return event
  }
}
