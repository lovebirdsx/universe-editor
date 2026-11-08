import {
  formatCertFingerprint,
  isValidPairCodeShape,
  normalizePairCode,
  parsePairFragment,
  parsePairFingerprint,
} from '@universe-editor/mobile-protocol'
import { useState, type FormEvent } from 'react'
import type { CredentialStore, SaveCredentialsResult, StoredCredentials } from '../credentials.js'
import { guessDevice, requestPair, type PairRequester } from '../pairing.js'
import { pairErrorText, strings } from '../strings.js'

export interface PairPageProps {
  readonly store: CredentialStore
  readonly onPaired: (credentials: StoredCredentials, result: SaveCredentialsResult) => void
  readonly pairRequest?: PairRequester | undefined
}

export function PairPage({ store, onPaired, pairRequest }: PairPageProps) {
  const [guess] = useState(() => guessDevice(navigator.userAgent))
  const [code, setCode] = useState(() => parsePairFragment(window.location.hash) ?? '')
  const [fingerprint] = useState(() => parsePairFingerprint(window.location.hash))
  const [deviceName, setDeviceName] = useState(guess.deviceName)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | undefined>(undefined)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return

    const normalizedCode = normalizePairCode(code)
    if (!isValidPairCodeShape(normalizedCode)) {
      setErrorText(strings.pairInvalidCode)
      return
    }
    const trimmedName = deviceName.trim()
    if (trimmedName === '') {
      setErrorText(strings.pairMissingDeviceName)
      return
    }

    setErrorText(undefined)
    setBusy(true)
    try {
      const requester = pairRequest ?? requestPair
      const result = await requester({
        code: normalizedCode,
        deviceName: trimmedName.slice(0, 64),
        platform: guess.platform,
      })
      if (!result.ok) {
        setErrorText(pairErrorText(result.network ? 'network' : result.code))
        return
      }

      const credentials: StoredCredentials = {
        deviceId: result.response.deviceId,
        token: result.response.token,
        pcName: result.response.pcName,
        deviceName: trimmedName.slice(0, 64),
        platform: guess.platform,
        protocolVersion: result.response.protocolVersion,
      }
      const saved = await store.save(credentials)
      // Clear the one-time code before the inbox paints so it never lingers in
      // history or a screenshot.
      history.replaceState(null, '', '/')
      onPaired(credentials, saved)
    } catch {
      setErrorText(strings.pairErrorUnknown)
    } finally {
      setBusy(false)
    }
  }

  const hasHashCode = parsePairFragment(window.location.hash) !== undefined

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

        <form className="pair-form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="field__label" htmlFor="pair-code">
              {strings.pairCodeLabel}
            </label>
            <input
              id="pair-code"
              className="field__input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={strings.pairCodePlaceholder}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              maxLength={9}
              disabled={busy}
            />
            {!hasHashCode && <span className="field__hint">{strings.pairCodeHint}</span>}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="pair-device-name">
              {strings.pairDeviceNameLabel}
            </label>
            <input
              id="pair-device-name"
              className="field__input"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder={strings.pairDeviceNamePlaceholder}
              autoComplete="off"
              maxLength={64}
              disabled={busy}
            />
          </div>

          {errorText !== undefined && (
            <p className="pair-form__error" role="alert">
              {errorText}
            </p>
          )}

          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? strings.pairSubmitting : strings.pairSubmit}
          </button>
        </form>
      </section>
    </main>
  )
}
