import type { JSX } from 'react'
import {
  CornerDownRight,
  File,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  FolderCode,
  FolderCog,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react'
import type { URI } from '@universe-editor/platform'
import { basenameOfResource, extensionOfBasename } from './resourceInfo.js'
import { languageForResource } from './resourceLanguage.js'
import styles from './FileIcon.module.css'

export type FileIconTone =
  | 'default'
  | 'folder'
  | 'folderSpecial'
  | 'code'
  | 'config'
  | 'markdown'
  | 'special'

interface FileIconDescriptor {
  readonly id: string
  readonly icon: LucideIcon
  readonly tone: FileIconTone
}

interface FileIconThemeData {
  readonly file: FileIconDescriptor
  readonly folder: FileIconDescriptor
  readonly folderExpanded: FileIconDescriptor
  readonly fileExtensions: Record<string, FileIconDescriptor>
  readonly fileNames: Record<string, FileIconDescriptor>
  readonly folderNames: Record<string, FileIconDescriptor>
  readonly folderNamesExpanded: Record<string, FileIconDescriptor>
  readonly languageIds: Record<string, FileIconDescriptor>
}

export interface ResolveFileIconOptions {
  readonly isDirectory: boolean
  readonly expanded?: boolean | undefined
  readonly languageId?: string | undefined
}

const THEME: FileIconThemeData = {
  file: { id: 'file-default', icon: File, tone: 'default' },
  folder: { id: 'folder-default', icon: Folder, tone: 'folder' },
  folderExpanded: { id: 'folder-default-open', icon: FolderOpen, tone: 'folder' },
  fileExtensions: {
    '.ts': { id: 'file-typescript', icon: FileCode2, tone: 'code' },
    '.tsx': { id: 'file-typescriptreact', icon: FileCode2, tone: 'code' },
    '.js': { id: 'file-javascript', icon: FileCode2, tone: 'code' },
    '.jsx': { id: 'file-javascriptreact', icon: FileCode2, tone: 'code' },
    '.mjs': { id: 'file-javascript', icon: FileCode2, tone: 'code' },
    '.cjs': { id: 'file-javascript', icon: FileCode2, tone: 'code' },
    '.json': { id: 'file-json', icon: FileJson2, tone: 'config' },
    '.jsonc': { id: 'file-json', icon: FileJson2, tone: 'config' },
    '.md': { id: 'file-markdown', icon: FileText, tone: 'markdown' },
    '.markdown': { id: 'file-markdown', icon: FileText, tone: 'markdown' },
    '.css': { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    '.scss': { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    '.less': { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    '.html': { id: 'file-html', icon: FileCode2, tone: 'special' },
    '.htm': { id: 'file-html', icon: FileCode2, tone: 'special' },
    '.xml': { id: 'file-xml', icon: FileCode2, tone: 'special' },
    '.yaml': { id: 'file-yaml', icon: FileJson2, tone: 'config' },
    '.yml': { id: 'file-yaml', icon: FileJson2, tone: 'config' },
  },
  fileNames: {
    'package.json': { id: 'file-package', icon: FileJson2, tone: 'config' },
    'tsconfig.json': { id: 'file-tsconfig', icon: FileJson2, tone: 'special' },
    'readme.md': { id: 'file-readme', icon: FileText, tone: 'markdown' },
  },
  folderNames: {
    src: { id: 'folder-src', icon: FolderCode, tone: 'folderSpecial' },
    '.vscode': { id: 'folder-vscode', icon: FolderCog, tone: 'folderSpecial' },
  },
  folderNamesExpanded: {
    src: { id: 'folder-src-open', icon: FolderCode, tone: 'folderSpecial' },
    '.vscode': { id: 'folder-vscode-open', icon: FolderCog, tone: 'folderSpecial' },
  },
  languageIds: {
    typescript: { id: 'file-typescript', icon: FileCode2, tone: 'code' },
    javascript: { id: 'file-javascript', icon: FileCode2, tone: 'code' },
    json: { id: 'file-json', icon: FileJson2, tone: 'config' },
    markdown: { id: 'file-markdown', icon: FileText, tone: 'markdown' },
    css: { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    scss: { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    less: { id: 'file-stylesheet', icon: FileCode2, tone: 'special' },
    html: { id: 'file-html', icon: FileCode2, tone: 'special' },
    xml: { id: 'file-xml', icon: FileCode2, tone: 'special' },
    yaml: { id: 'file-yaml', icon: FileJson2, tone: 'config' },
  },
}

export function resolveFileIcon(
  resource: URI,
  options: ResolveFileIconOptions,
): FileIconDescriptor {
  const name = basenameOfResource(resource).toLowerCase()
  if (options.isDirectory) {
    const special = options.expanded
      ? (THEME.folderNamesExpanded[name] ?? THEME.folderNames[name])
      : THEME.folderNames[name]
    if (special) return special
    return options.expanded ? THEME.folderExpanded : THEME.folder
  }

  const byName = THEME.fileNames[name]
  if (byName) return byName

  const ext = extensionOfBasename(name)
  if (ext) {
    const byExt = THEME.fileExtensions[ext]
    if (byExt) return byExt
  }

  const language = options.languageId ?? languageForResource(resource)
  return THEME.languageIds[language] ?? THEME.file
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
  const resolved = resolveFileIcon(resource, { isDirectory, expanded, languageId })
  const Icon = resolved.icon
  const toneClass =
    resolved.tone === 'default'
      ? ''
      : resolved.tone === 'folderSpecial'
        ? styles['tone-folderSpecial']
        : styles[`tone-${resolved.tone}`]

  return (
    <span
      className={[styles['fileIcon'], toneClass, className].filter(Boolean).join(' ')}
      data-file-icon={resolved.id}
      aria-hidden="true"
    >
      <Icon size={size} strokeWidth={1.75} />
      {symbolicLink && (
        <span className={styles['symlinkBadge']} data-symlink-badge="true">
          <CornerDownRight size={9} strokeWidth={2.5} />
        </span>
      )}
    </span>
  )
}
