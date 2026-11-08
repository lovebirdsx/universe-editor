import {
  formatCertFingerprint,
  parsePairFragment,
  parsePairFingerprint,
} from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import { PairForm } from '../components/PairForm.js'
import type { CredentialStore, SaveCredentialsResult, StoredCredentials } from '../credentials.js'
import type { PairRequester } from '../pairing.js'
import { strings } from '../strings.js'

export interface PairPageProps {
  readonly store: CredentialStore
  readonly onPaired: (credentials: StoredCredentials, result: SaveCredentialsResult) => void
  readonly pairRequest?: PairRequester | undefined
}

export function PairPage({ store, onPaired, pairRequest }: PairPageProps) {
  const [fragmentCode] = useState(() => parsePairFragment(window.location.hash))
  const [fingerprint] = useState(() => parsePairFingerprint(window.location.hash))

  const handlePaired = (credentials: StoredCredentials, result: SaveCredentialsResult): void => {
    // Clear the one-time code before the inbox paints so it never lingers in
    // history or a screenshot.
    history.replaceState(null, '', '/')
    onPaired(credentials, result)
  }

  return (
    <main className="pair-page">
      <header className="pair-page__brand">
        <span className="pair-page__logo" aria-hidden="true" />
        <div>
          <p className="pair-page__app-name">{strings.appName}</p>
          <p className="pair-page__tagline">{strings.appTagline}</p>
        </div>
      </header>

      <section className="card">
        <h1 className="pair-page__title">{strings.pairTitle}</h1>
        <p className="pair-page__intro">{strings.pairIntro}</p>

        {fingerprint !== undefined && (
          <div className="pair-page__fingerprint" data-testid="pair-certificate">
            <div className="field__label">{strings.pairCertTitle}</div>
            <code className="pair-page__fingerprint-value">
              {formatCertFingerprint(fingerprint)}
            </code>
            <p className="field__hint">{strings.pairCertHint}</p>
          </div>
        )}

        <PairForm
          store={store}
          onPaired={handlePaired}
          pairRequest={pairRequest}
          initialCode={fragmentCode ?? ''}
          hideCodeHint={fragmentCode !== undefined}
        />
      </section>
    </main>
  )
}
