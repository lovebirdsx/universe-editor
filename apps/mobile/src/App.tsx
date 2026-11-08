import { MOBILE_PAIR_PAGE_PATH } from '@universe-editor/mobile-protocol'
import { useMemo, useState } from 'react'
import {
  createCredentialStore,
  type SaveCredentialsResult,
  type StoredCredentials,
} from './credentials.js'
import { InboxPage } from './pages/InboxPage.js'
import { PairPage } from './pages/PairPage.js'
import { strings } from './strings.js'

type Route = 'pair' | 'inbox'

export function App() {
  const store = useMemo(() => createCredentialStore(), [])
  const [route, setRoute] = useState<Route>(() =>
    window.location.pathname === MOBILE_PAIR_PAGE_PATH ? 'pair' : 'inbox',
  )
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const handlePaired = (_credentials: StoredCredentials, result: SaveCredentialsResult): void => {
    setNotice(result.persisted ? undefined : strings.pairStorageUnavailable)
    setReloadKey((value) => value + 1)
    setRoute('inbox')
  }

  if (route === 'pair') {
    return <PairPage store={store} onPaired={handlePaired} />
  }

  return (
    <InboxPage
      store={store}
      reloadKey={reloadKey}
      notice={notice}
      onDismissNotice={() => setNotice(undefined)}
    />
  )
}
