/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File type icon: dual rendering modes driven by the active file icon theme.
 *--------------------------------------------------------------------------------------------*/

import { type JSX, useEffect, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import { IThemeService, type URI } from '@universe-editor/platform'
import { useOptionalService } from '../useService.js'
import { basenameOfResource } from './resourceInfo.js'
import { languageForResource } from './resourceLanguage.js'
import {
  materialIconDefaults,
  materialFileExtensions,
  materialFileNames,
  materialLanguageIds,
  materialFolderNames,
  materialFolderNamesExpanded,
} from './materialIconMap.js'
import { getFileIconClasses } from './fileIconClasses.js'
import type { WorkbenchThemeService } from '../../services/themes/workbenchThemeService.js'
import styles from './FileIcon.module.css'

// Inline every generated Material SVG as raw markup. `eager` keeps them in the
// main chunk (they're tiny and needed synchronously during tree rendering), and
// `?raw` gives us the string we render via dangerouslySetInnerHTML — no <img>,
// no custom scheme, and happy-dom tests can assert on the markup directly.
// This is the BUILT-IN DEFAULT path (no icon theme configured); once an icon
// theme activates, FileIcon switches to the stylesheet-driven protocol classes
// and these inlined SVGs stop being used.
const rawSvgs = import.meta.glob<string>('./icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const svgByName: Record<string, string> = {}
for (const [path, source] of Object.entries(rawSvgs)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length)
  svgByName[name] = source
}

export interface ResolveFileIconOptions {
  readonly isDirectory: boolean
  readonly expanded?: boolean | undefined
  readonly languageId?: string | undefined
}

export interface FileIconDescriptor {
  /** Material icon name; also the DOM `data-file-icon` value as `mi-<name>`. */
  readonly icon: string
  /** Stable identifier for tests/debugging (`mi-<icon>`). */
  readonly id: string
}

function descriptor(iconName: string): FileIconDescriptor {
  const icon = svgByName[iconName] ? iconName : materialIconDefaults.file
  return { icon, id: `mi-${icon}` }
}

// Longest-suffix extension match: `foo.spec.ts` tries `spec.ts` then `ts`.
function matchExtension(lowerName: string): string | undefined {
  let from = lowerName.indexOf('.')
  while (from !== -1) {
    const suffix = lowerName.slice(from + 1)
    const hit = materialFileExtensions[suffix]
    if (hit) return hit
    from = lowerName.indexOf('.', from + 1)
  }
  return undefined
}

export function resolveFileIcon(
  resource: URI,
  options: ResolveFileIconOptions,
): FileIconDescriptor {
  const name = basenameOfResource(resource).toLowerCase()

  if (options.isDirectory) {
    const special = options.expanded
      ? (materialFolderNamesExpanded[name] ?? materialFolderNames[name])
      : materialFolderNames[name]
    if (special) return descriptor(special)
    return descriptor(
      options.expanded ? materialIconDefaults.folderExpanded : materialIconDefaults.folder,
    )
  }

  const byName = materialFileNames[name]
  if (byName) return descriptor(byName)

  const byExt = matchExtension(name)
  if (byExt) return descriptor(byExt)

  const language = options.languageId ?? languageForResource(resource)
  const byLang = materialLanguageIds[language]
  if (byLang) return descriptor(byLang)

  return descriptor(materialIconDefaults.file)
}

/**
 * Whether a stylesheet-driven file icon theme is active (any theme with an id
 * selected, including after hot-switching). Subscribed via
 * `onDidFileIconThemeChange` so a theme switch re-renders icons. Unit tests
 * render FileIcon without a theme service in the container — the optional
 * lookup keeps them on the built-in inline-SVG path.
 */
function useFileIconThemeActive(): boolean {
  const themeService = useOptionalService(IThemeService) as WorkbenchThemeService | undefined
  const [active, setActive] = useState(() => (themeService?.getFileIconTheme().id ?? '') !== '')
  useEffect(() => {
    if (!themeService) return
    const update = (): void => setActive(themeService.getFileIconTheme().id !== '')
    update()
    const d = themeService.onDidFileIconThemeChange(update)
    return () => d.dispose()
  }, [themeService])
  return active
}

export interface FileIconProps extends ResolveFileIconOptions {
  readonly resource: URI
  readonly className?: string | undefined
  readonly size?: number | undefined
  /** Overlays a small link badge to mark the entry as a symbolic link. */
  readonly symbolicLink?: boolean | undefined
}

export function FileIcon({
  resource,
  isDirectory,
  expanded,
  languageId,
  className,
  size = 16,
  symbolicLink,
}: FileIconProps): JSX.Element {
  const themeActive = useFileIconThemeActive()

  if (themeActive) {
    // Stylesheet mode: emit only the protocol classes; the contributed
    // icon-theme CSS paints the glyph through `::before` background/content.
    const classes = getFileIconClasses(resource, {
      isDirectory,
      ...(languageId !== undefined
        ? { languageId }
        : { languageId: languageForResource(resource) }),
    })
    const stateClass =
      isDirectory && expanded === true
        ? classes.map((c) => (c === 'folder-icon' ? 'folder-expanded-icon' : c))
        : classes
    return (
      <span
        className={[styles['fileIcon'], ...stateClass, className].filter(Boolean).join(' ')}
        data-file-icon={isDirectory ? 'folder' : 'file'}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {symbolicLink && (
          <span className={styles['symlinkBadge']} data-symlink-badge="true">
            <CornerDownRight size={9} strokeWidth={2.5} />
          </span>
        )}
      </span>
    )
  }

  const resolved = resolveFileIcon(resource, { isDirectory, expanded, languageId })
  const svg = svgByName[resolved.icon] ?? svgByName[materialIconDefaults.file]

  return (
    <span
      className={[styles['fileIcon'], className].filter(Boolean).join(' ')}
      data-file-icon={resolved.id}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className={styles['glyph']}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: svg ?? '' }}
      />
      {symbolicLink && (
        <span className={styles['symlinkBadge']} data-symlink-badge="true">
          <CornerDownRight size={9} strokeWidth={2.5} />
        </span>
      )}
    </span>
  )
}
