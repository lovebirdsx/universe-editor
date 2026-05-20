/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsTree — file-grouped list of search matches.
 *--------------------------------------------------------------------------------------------*/

import { type CSSProperties, useState } from 'react'
import { URI, type IFileMatch, type ITextSearchMatch } from '@universe-editor/platform'
import { VirtualList } from '@universe-editor/workbench-ui'
import { FileIcon } from '../files/fileIconTheme.js'
import { basenameOfResource, dirnameOfResource } from '../files/resourceInfo.js'
import styles from './SearchView.module.css'

export interface SearchResultsTreeProps {
  results: readonly IFileMatch[]
  onActivateMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  onReplaceMatch?:
    | ((resource: URI, match: ITextSearchMatch, rangeIndex: number) => void)
    | undefined
  onReplaceFile?: ((resource: URI) => void) | undefined
  replaceVisible?: boolean
  virtualizationThreshold?: number
}

function highlight(preview: string, ranges: readonly { startColumn: number; endColumn: number }[]) {
  if (ranges.length === 0) return preview
  const out: React.ReactNode[] = []
  let cursor = 0
  ranges.forEach((r, i) => {
    const start = Math.max(r.startColumn - 1, 0)
    const end = Math.max(r.endColumn - 1, start)
    if (start > cursor) out.push(preview.slice(cursor, start))
    out.push(
      <span key={i} className={styles['match']}>
        {preview.slice(start, end)}
      </span>,
    )
    cursor = end
  })
  if (cursor < preview.length) out.push(preview.slice(cursor))
  return out
}

function FileGroup({
  fileMatch,
  defaultExpanded,
  onActivateMatch,
  onReplaceFile,
  onReplaceMatch,
  replaceVisible,
  style,
}: {
  fileMatch: IFileMatch
  defaultExpanded: boolean
  onActivateMatch: SearchResultsTreeProps['onActivateMatch']
  onReplaceFile: SearchResultsTreeProps['onReplaceFile']
  onReplaceMatch: SearchResultsTreeProps['onReplaceMatch']
  replaceVisible: boolean | undefined
  style?: CSSProperties
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const resource = URI.revive(fileMatch.resource) as URI
  const total = fileMatch.matches.reduce((n, m) => n + m.ranges.length, 0)
  return (
    <div className={styles['fileGroup']} style={style}>
      <div className={styles['fileHeader']}>
        <button
          type="button"
          className={styles['fileToggle']}
          aria-expanded={expanded}
          aria-label={`Toggle ${basenameOfResource(resource)}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <FileIcon
          resource={resource}
          isDirectory={false}
          className={styles['fileHeaderIcon']}
          size={14}
        />
        <span className={styles['fileName']}>{basenameOfResource(resource)}</span>
        <span className={styles['filePath']}>{dirnameOfResource(resource)}</span>
        <span className={styles['fileCount']} aria-label={`${total} matches`}>
          {total}
        </span>
        {replaceVisible && onReplaceFile && (
          <button
            type="button"
            className={styles['replaceBtn']}
            title="Replace All in File"
            aria-label={`Replace all in ${basenameOfResource(resource)}`}
            onClick={() => onReplaceFile(resource)}
          >
            ⇄
          </button>
        )}
      </div>
      {expanded && (
        <ul className={styles['matchList']}>
          {fileMatch.matches.map((m) =>
            m.ranges.map((_, ri) => (
              <li
                key={`${m.lineNumber}:${ri}`}
                className={styles['matchRow']}
                onClick={() => onActivateMatch(resource, m, ri)}
                role="button"
                tabIndex={0}
              >
                <span className={styles['lineNumber']}>{m.lineNumber}</span>
                <span className={styles['matchPreview']}>{highlight(m.preview, m.ranges)}</span>
                {replaceVisible && onReplaceMatch && (
                  <button
                    type="button"
                    className={styles['replaceBtn']}
                    title="Replace"
                    aria-label={`Replace match at line ${m.lineNumber}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onReplaceMatch(resource, m, ri)
                    }}
                  >
                    ⇄
                  </button>
                )}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  )
}

export function SearchResultsTree({
  results,
  onActivateMatch,
  onReplaceFile,
  onReplaceMatch,
  replaceVisible,
  virtualizationThreshold = 200,
}: SearchResultsTreeProps) {
  if (results.length > virtualizationThreshold) {
    return (
      <VirtualList
        items={results}
        estimateSize={() => 28}
        className={styles['resultsTree'] ?? ''}
        renderItem={(fm, style) => (
          <FileGroup
            key={(URI.revive(fm.resource) as URI).toString()}
            fileMatch={fm}
            defaultExpanded={false}
            onActivateMatch={onActivateMatch}
            onReplaceFile={onReplaceFile}
            onReplaceMatch={onReplaceMatch}
            replaceVisible={replaceVisible}
            style={style}
          />
        )}
      />
    )
  }

  return (
    <div className={styles['resultsTree']} role="tree">
      {results.map((fm, i) => (
        <FileGroup
          key={(URI.revive(fm.resource) as URI).toString()}
          fileMatch={fm}
          defaultExpanded={i < 5}
          onActivateMatch={onActivateMatch}
          onReplaceFile={onReplaceFile}
          onReplaceMatch={onReplaceMatch}
          replaceVisible={replaceVisible}
        />
      ))}
    </div>
  )
}
