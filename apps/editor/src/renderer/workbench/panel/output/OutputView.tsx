import { IConfigurationService, IOutputService } from '@universe-editor/platform'
import { useService, useObservable } from '../../useService.js'
import { LogOutputView } from './LogOutputView.js'
import styles from './OutputView.module.css'

export function OutputView() {
  const outputService = useService(IOutputService)
  const configService = useService(IConfigurationService)
  const content = useObservable(outputService.activeChannelContent)
  const theme = configService.get<string>('workbench.colorTheme') === 'light' ? 'vs' : 'vs-dark'

  return (
    <div className={styles['outputView']}>
      <div className={styles['content']}>
        {content ? (
          <LogOutputView content={content} theme={theme} />
        ) : (
          <div className={styles['empty']}>No output.</div>
        )}
      </div>
    </div>
  )
}
