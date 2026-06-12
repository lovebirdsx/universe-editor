/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MermaidBlock — renders a ```mermaid fenced block as an SVG diagram via the
 *  lazy-loaded `mermaid` package. Tracks the active workbench colour theme so
 *  diagrams follow dark/light, and falls back to the raw code (via CodeBlock)
 *  when the diagram source has a syntax error. mermaid runs its SVG output
 *  through DOMPurify (securityLevel 'strict'), so dangerouslySetInnerHTML is safe.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { IConfigurationService } from '@universe-editor/platform'
import { CodeBlock } from '../agents/CodeBlock.js'
import { useService } from '../useService.js'
import { MermaidLoader } from './mermaidLoader.js'
import styles from './markdown.module.css'

function useIsDarkTheme(): boolean {
  const configuration = useService(IConfigurationService)
  const [isDark, setIsDark] = useState(
    () => configuration.get<string>('workbench.colorTheme') !== 'light',
  )
  useEffect(() => {
    const sub = configuration.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.colorTheme')) {
        setIsDark(configuration.get<string>('workbench.colorTheme') !== 'light')
      }
    })
    return () => sub.dispose()
  }, [configuration])
  return isDark
}

export function MermaidBlock({ code }: { readonly code: string }) {
  const isDark = useIsDarkTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void MermaidLoader.render(code, isDark ? 'dark' : 'default')
      .then((rendered) => {
        if (!cancelled) setSvg(rendered)
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [code, isDark])

  if (failed || svg === null) {
    return <CodeBlock code={code} lang="mermaid" />
  }
  return (
    <div
      className={styles['mermaidBlock']}
      data-testid="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
