import { useEffect, useState } from 'react'
import {
  IConfigurationService,
  IOutputService,
  localize,
  markAsSingleton,
} from '@universe-editor/platform'
import {
  OUTPUT_FONT_FAMILY_DEFAULT,
  OUTPUT_FONT_SIZE_DEFAULT,
  normalizeFontFamily,
} from '../../../services/configuration/fontDefaults.js'
import { useService, useObservable } from '../../useService.js'
import type { IViewComponentProps } from '../../../services/views/ViewComponentRegistry.js'
import { LogOutputView } from './LogOutputView.js'
import styles from './OutputView.module.css'

export function OutputView({ viewId }: IViewComponentProps) {
  const configService = useService(IConfigurationService)
  // Gate on whether a channel is active, not on whether it has content: an
  // output channel is always a focusable read-only editor (VSCode parity), even
  // when empty. Gating on content meant a first-opened empty channel never
  // mounted LogOutputView, so no focusable primary was ever registered and
  // focusView() stranded keyboard focus on the ViewBody fallback container.
  const hasActiveChannel = useObservable(useService(IOutputService).activeChannelName) !== undefined

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
        {hasActiveChannel ? (
          <LogOutputView fontSize={fontSize} fontFamily={fontFamily} viewId={viewId} />
        ) : (
          <div className={styles['empty']} style={{ fontSize: `${fontSize}px`, fontFamily }}>
            {localize('output.empty', 'No output.')}
          </div>
        )}
      </div>
    </div>
  )
}
