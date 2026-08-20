/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InstallInRemoteButton — the "install a local-side extension into the remote"
 *  affordance shared by the Extensions view row and the detail header. Resolves
 *  marketplace availability lazily; while resolving the button is disabled, and
 *  when there's no marketplace entry (pure local VSIX / unreachable) it renders a
 *  badge with an explanatory tooltip instead.
 *--------------------------------------------------------------------------------------------*/

import { Button, Spinner } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import { useInstallInRemote } from './useInstallInRemote.js'
import type { IExtensionEntry } from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

export function InstallInRemoteButton({
  entry,
  label,
  variant = 'secondary',
  badgeClassName,
}: {
  entry: IExtensionEntry
  label: string
  variant?: 'primary' | 'secondary' | 'ghost'
  badgeClassName: string | undefined
}) {
  const { available, install } = useInstallInRemote(entry)
  if (entry.installing) return <Spinner size={14} />
  if (available === false) {
    return (
      <span
        className={badgeClassName}
        data-tooltip={localize(
          'extensions.installInRemote.unavailable',
          'This extension is not available in the marketplace, so it cannot be installed in the remote workspace.',
        )}
        data-testid="extension-remote-unavailable"
      >
        {localize('extensions.installInRemote.unavailable.badge', 'Unavailable in Remote')}
      </span>
    )
  }
  return (
    <Button variant={variant} disabled={available === undefined} onClick={install}>
      {label}
    </Button>
  )
}
