import { useEffect, useState } from 'react'
import { IConfigurationService, IOutputService, markAsSingleton } from '@universe-editor/platform'
import {
  OUTPUT_FONT_FAMILY_DEFAULT,
  OUTPUT_FONT_SIZE_DEFAULT,
  normalizeFontFamily,
} from '../../../services/configuration/fontDefaults.js'
import { useService, useObservable } from '../../useService.js'
import { LogOutputView } from './LogOutputView.js'
import styles from './OutputView.module.css'

export function OutputView() {
  const outputService = useService(IOutputService)
  const configService = useService(IConfigurationService)
  const content = useObservable(outputService.activeChannelContent)
  const theme = configService.get<string>('workbench.colorTheme') === 'light' ? 'vs' : 'vs-dark'

  const [fontSize, setFontSize] = useState(
    () => configService.get<number>('output.fontSize') ?? OUTPUT_FONT_SIZE_DEFAULT,
  )
  const [fontFamily, setFontFamily] = useState(() =>
    normalizeFontFamily(configService.get<string>('output.fontFamily'), OUTPUT_FONT_FAMILY_DEFAULT),
  )

  useEffect(() => {
    const d = markAsSingleton(
      configService.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('output.fontSize')) {
          setFontSize(configService.get<number>('output.fontSize') ?? OUTPUT_FONT_SIZE_DEFAULT)
        }
        if (e.affectsConfiguration('output.fontFamily')) {
          setFontFamily(
            normalizeFontFamily(
              configService.get<string>('output.fontFamily'),
              OUTPUT_FONT_FAMILY_DEFAULT,
            ),
          )
        }
      }),
    )
    return () => d.dispose()
  }, [configService])

  return (
    <div className={styles['outputView']}>
      <div className={styles['content']}>
        {content ? (
          <LogOutputView
            content={content}
            theme={theme}
            fontSize={fontSize}
            fontFamily={fontFamily}
          />
        ) : (
          <div className={styles['empty']} style={{ fontSize: `${fontSize}px`, fontFamily }}>
            No output.
          </div>
        )}
      </div>
    </div>
  )
}
