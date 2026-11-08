import { NoticeBar } from '../components/NoticeBar.js'
import { PairForm } from '../components/PairForm.js'
import type { CredentialStore, SaveCredentialsResult, StoredCredentials } from '../credentials.js'
import type { PairRequester } from '../pairing.js'
import { strings } from '../strings.js'

export interface GuidePageProps {
  readonly store: CredentialStore
  readonly onPaired: (credentials: StoredCredentials, result: SaveCredentialsResult) => void
  readonly notice?: string | undefined
  readonly onDismissNotice: () => void
  readonly pairRequest?: PairRequester | undefined
}

export function GuidePage({
  store,
  onPaired,
  notice,
  onDismissNotice,
  pairRequest,
}: GuidePageProps) {
  const handlePaired = (credentials: StoredCredentials, result: SaveCredentialsResult): void => {
    // Credentials can be lost while a session URL is open; drop the stale deep
    // link so a refresh after re-pairing does not reopen a dead session.
    history.replaceState(null, '', '/')
    onPaired(credentials, result)
  }

  return (
    <main className="guide-page">
      {notice !== undefined && <NoticeBar text={notice} onDismiss={onDismissNotice} />}
      <span className="guide-page__logo" aria-hidden="true" />
      <h1 className="guide-page__title">{strings.guideTitle}</h1>
      <p className="guide-page__body">{strings.guideBody}</p>
      <p className="guide-page__hint">{strings.guideHint}</p>
      <section className="card guide-page__pair">
        <h2 className="guide-page__pair-title">{strings.guidePairTitle}</h2>
        <PairForm store={store} onPaired={handlePaired} pairRequest={pairRequest} />
      </section>
    </main>
  )
}
