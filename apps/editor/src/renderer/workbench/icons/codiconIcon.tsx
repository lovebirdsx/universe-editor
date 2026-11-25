/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders any id from the codicon font as a React component. `@vscode/codicons`
 *  is loaded globally (see main.tsx), so extensions can use the full codicon
 *  vocabulary without the workbench's Lucide table growing to match it.
 *
 *  The component is cached per id+modifier: `resolveIcon` runs during render and
 *  must keep a stable component identity or React would remount the glyph.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties, ReactNode } from 'react'
import type { WorkbenchIcon, WorkbenchIconProps } from './iconComponent.js'

interface CodiconGlyphProps extends WorkbenchIconProps {
  readonly id: string
  readonly modifier: string | undefined
}

function CodiconGlyph({
  id,
  modifier,
  size = 16,
  className,
  style,
  color,
  'aria-hidden': ariaHidden = true,
  'data-testid': dataTestId,
}: CodiconGlyphProps): ReactNode {
  const classes = [
    'codicon',
    `codicon-${id}`,
    modifier === undefined ? undefined : `codicon-modifier-${modifier}`,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  const glyphStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: size,
    lineHeight: 1,
    verticalAlign: 'middle',
    ...(color === undefined ? {} : { color }),
    ...style,
    // codicon.css only spins sync/loading/gear; an inline animation lets any
    // icon honour `~spin` inside an `icon` field.
    ...(modifier === 'spin'
      ? { animation: 'codicon-spin 1.5s steps(30) infinite', transformOrigin: '50% 50%' }
      : {}),
  }

  return (
    <span
      className={classes}
      style={glyphStyle}
      aria-hidden={ariaHidden}
      data-testid={dataTestId}
    />
  )
}

const cache = new Map<string, WorkbenchIcon>()

export function getCodiconIcon(id: string, modifier: string | undefined): WorkbenchIcon {
  const key = modifier === undefined ? id : `${id}~${modifier}`
  let Icon = cache.get(key)
  if (Icon === undefined) {
    Icon = (props: WorkbenchIconProps) => <CodiconGlyph {...props} id={id} modifier={modifier} />
    Icon.displayName = `Codicon(${key})`
    cache.set(key, Icon)
  }
  return Icon
}
