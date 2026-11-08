import { isValidPairCodeShape, normalizePairCode } from '@universe-editor/mobile-protocol'
import { useState, type FormEvent } from 'react'
import type { CredentialStore, SaveCredentialsResult, StoredCredentials } from '../credentials.js'
import { guessDevice, requestPair, type PairRequester } from '../pairing.js'
import { pairErrorText, strings } from '../strings.js'

export interface PairFormProps {
  readonly store: CredentialStore
  readonly onPaired: (credentials: StoredCredentials, result: SaveCredentialsResult) => void
  readonly pairRequest?: PairRequester | undefined
  readonly initialCode?: string
  readonly hideCodeHint?: boolean
}

export function PairForm({
  store,
  onPaired,
  pairRequest,
  initialCode = '',
  hideCodeHint = false,
}: PairFormProps) {
  const [guess] = useState(() => guessDevice(navigator.userAgent))
  const [code, setCode] = useState(initialCode)
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
      onPaired(credentials, saved)
    } catch {
      setErrorText(strings.pairErrorUnknown)
    } finally {
      setBusy(false)
    }
  }

  return (
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
        {!hideCodeHint && <span className="field__hint">{strings.pairCodeHint}</span>}
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
  )
}
