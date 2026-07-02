/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ImageEditor — read-only preview of an image file (ImageEditorInput).
 *
 *  Renders the picture centered over a checkerboard transparency background,
 *  loaded via the `ue-file:` custom protocol (see main/ipc/imageProtocol.ts).
 *  Mirrors VSCode's media-preview: click toggles fit <-> 100%, Ctrl/Cmd+wheel
 *  zooms at the cursor, and the status bar shows pixel dimensions, byte size and
 *  the current zoom level while this editor is active.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react'
import {
  IEditorGroupsService,
  IFileService,
  IStatusBarService,
  StatusBarAlignment,
  localize,
  type IEditorInput,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { fileUriToImageUrl } from '../../../shared/imageResource.js'
import { ImageEditorInput } from '../../services/editor/ImageEditorInput.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { useService } from '../useService.js'
import styles from './ImageEditor.module.css'

const MIN_SCALE = 0.1
const MAX_SCALE = 32

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface NaturalSize {
  readonly width: number
  readonly height: number
}

export function ImageEditor({ input }: { input: IEditorInput }) {
  const imageInput = input as ImageEditorInput
  const resource = imageInput.resource
  const src = fileUriToImageUrl(resource)

  const fileService = useService(IFileService)
  const statusBarService = useService(IStatusBarService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)

  const containerRef = useRef<HTMLDivElement | null>(null)

  const [natural, setNatural] = useState<NaturalSize | null>(null)
  const [byteSize, setByteSize] = useState<number | null>(null)
  const [error, setError] = useState(false)
  // `null` scale means "fit to viewport"; a number is an explicit zoom factor.
  const [scale, setScale] = useState<number | null>(null)

  const activeGroup = groupsService.activeGroup
  const isActive = activeGroup === group && activeGroup.activeEditor === imageInput

  useEffect(() => {
    let cancelled = false
    void fileService
      .stat(resource)
      .then((stat) => {
        if (!cancelled) setByteSize(stat.size)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [fileService, resource])

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setNatural({ width: img.naturalWidth, height: img.naturalHeight })
    setError(false)
  }, [])

  const zoomAt = useCallback((factor: number) => {
    setScale((prev) => {
      const base = prev ?? 1
      return clamp(base * factor, MIN_SCALE, MAX_SCALE)
    })
  }, [])

  const onWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      // Match VSCode: only zoom when Ctrl/Cmd is held, so a plain wheel scrolls.
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomAt(Math.exp(-e.deltaY * 0.002))
    },
    [zoomAt],
  )

  // Click toggles between fit and 100%, like VSCode's image preview.
  const onClickImage = useCallback(() => {
    setScale((prev) => (prev === null ? 1 : null))
  }, [])

  // Keyboard zoom while this editor is active (Ctrl/Cmd +/-/0).
  useEffect(() => {
    if (!isActive) return
    const el = containerRef.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomAt(1.2)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomAt(1 / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        setScale(null)
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [isActive, zoomAt])

  // Status-bar entries — only while this editor is the active one.
  const sizeEntry = useRef<IStatusBarEntryAccessor | null>(null)
  const zoomEntry = useRef<IStatusBarEntryAccessor | null>(null)
  const byteEntry = useRef<IStatusBarEntryAccessor | null>(null)

  useEffect(() => {
    if (!isActive) return
    const size = statusBarService.addEntry({
      text: natural ? `${natural.width}x${natural.height}` : '—',
      tooltip: localize('image.status.dimensions', 'Image dimensions'),
      alignment: StatusBarAlignment.Right,
      priority: 101,
    })
    const bytes = statusBarService.addEntry({
      text: byteSize !== null ? formatSize(byteSize) : '—',
      tooltip: localize('image.status.size', 'File size'),
      alignment: StatusBarAlignment.Right,
      priority: 100,
    })
    const zoom = statusBarService.addEntry({
      text: scale === null ? localize('image.status.fit', 'Fit') : `${Math.round(scale * 100)}%`,
      tooltip: localize('image.status.zoom', 'Zoom level'),
      alignment: StatusBarAlignment.Right,
      priority: 99,
    })
    sizeEntry.current = size
    byteEntry.current = bytes
    zoomEntry.current = zoom
    return () => {
      size.dispose()
      bytes.dispose()
      zoom.dispose()
      sizeEntry.current = null
      byteEntry.current = null
      zoomEntry.current = null
    }
    // Recreate whenever the displayed values change; cheap and keeps text fresh.
  }, [isActive, statusBarService, natural, byteSize, scale])

  // Focus the container on activation so keyboard zoom works without a click.
  useLayoutEffect(() => {
    if (isActive) containerRef.current?.focus()
  }, [isActive])

  const imgStyle =
    scale === null
      ? undefined
      : { width: natural ? `${natural.width * scale}px` : undefined, maxWidth: 'none' as const }

  return (
    <div
      ref={containerRef}
      className={styles['imageEditorRoot']}
      data-testid="image-editor"
      tabIndex={0}
      onWheel={onWheel}
    >
      {error ? (
        <div className={styles['imageEditorMessage']}>
          {localize('image.load.failed', 'Cannot display this image.')}
        </div>
      ) : (
        <div className={styles['imageEditorStage']}>
          <img
            src={src}
            alt={imageInput.getName()}
            className={scale === null ? styles['imageFit'] : styles['imageZoomed']}
            draggable={false}
            onLoad={onLoad}
            onError={() => setError(true)}
            onClick={onClickImage}
            {...(imgStyle ? { style: imgStyle } : {})}
          />
        </div>
      )}
    </div>
  )
}
