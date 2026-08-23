/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GatewayProviderPicker — the shared "which provider serves this agent" control
 *  used by the Claude and Codex authentication panels. It lists the resolved
 *  provider entries that declare the agent's protocol, prepends the
 *  `@subscription` option (the agent's official login), offers a connectivity dot
 *  + "Test" probe (only on an explicit click, never from render), and delegates
 *  the derived-preview rendering to the caller via a render prop. A
 *  saved-but-now-incompatible selection stays visible with a warning rather than
 *  disappearing.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  IAiModelService,
  ICommandService,
  localize,
  type AiResolvedProvider,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { Button, Spinner } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { findProviderById } from '../../../shared/ai/providerDerivation.js'
import { isOfficialEndpoint } from '../../../shared/ai/officialEndpoints.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../shared/ipc/claudeConfigService.js'
import { ManageModelsAction } from '../../actions/aiActions.js'
import styles from './AgentSettingsEditor.module.css'

/** Which credential piece prevents the CLI derivation, if any. */
export function missingProviderPiece(
  provider: AiResolvedProvider,
  protocol: AiWireProtocol,
): 'apiKey' | 'baseUrl' | undefined {
  if (provider.apiKey === undefined || provider.apiKey.trim() === '') return 'apiKey'
  // Claude's official endpoint needs only the key; gateways (and Codex, which has
  // no "official provider" mode — that is the ChatGPT subscription) need a URL.
  const keyOnly =
    protocol === 'anthropic-messages' && isOfficialEndpoint(protocol, provider.baseUrl)
  if (!keyOnly && (provider.baseUrl === undefined || provider.baseUrl.trim() === '')) {
    return 'baseUrl'
  }
  return undefined
}

type VerifyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

export function GatewayProviderPicker({
  providers,
  protocol,
  value,
  onChange,
  subscriptionLabel,
  children,
}: {
  readonly providers: readonly AiResolvedProvider[]
  readonly protocol: AiWireProtocol
  /** Provider id, `@subscription`, or '' (unset). */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly subscriptionLabel: string
  readonly children: (resolved: AiResolvedProvider | undefined) => ReactNode
}) {
  const aiModel = useService(IAiModelService)
  const commands = useService(ICommandService)
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })

  const selectable = useMemo(
    () => providers.filter((p) => p.protocols.some((pr) => pr.protocol === protocol)),
    [providers, protocol],
  )

  // Resolve the saved id against the full list — a selected provider that has
  // since become incompatible must stay visible, not vanish from the UI.
  const resolved = useMemo(
    () =>
      value && value !== AGENT_SUBSCRIPTION_AUTH ? findProviderById(providers, value) : undefined,
    [value, providers],
  )

  const incompatible = useMemo(() => {
    if (resolved === undefined) return undefined
    return resolved.protocols.some((pr) => pr.protocol === protocol) ? undefined : resolved
  }, [resolved, protocol])

  const options = useMemo(
    () => (incompatible ? [...selectable, incompatible] : selectable),
    [selectable, incompatible],
  )

  useEffect(() => {
    setVerify({ kind: 'idle' })
  }, [value])

  const test = useCallback(() => {
    if (!resolved) return
    setVerify({ kind: 'checking' })
    void aiModel
      .verifyProvider({
        id: resolved.id,
        protocol,
        ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
        ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
      })
      .then((result) => {
        setVerify(
          result.ok
            ? { kind: 'ok', modelCount: result.modelCount }
            : {
                kind: 'fail',
                error:
                  result.error ??
                  localize('agentSettings.auth.provider.verifyFail', 'Connection failed.'),
              },
        )
      })
  }, [resolved, aiModel, protocol])

  if (providers.length === 0) {
    return (
      <div className={styles['noProviders']}>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.provider.none',
            'No provider entries with a compatible protocol yet. Add one in the AI settings, then select it here.',
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void commands.executeCommand(ManageModelsAction.ID)}
        >
          {localize('agentSettings.auth.provider.add', 'Add a provider…')}
        </Button>
      </div>
    )
  }

  if (selectable.length === 0 && resolved === undefined) {
    return (
      <div className={styles['noProviders']}>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.auth.provider.noneCompatible',
            'You have {count} provider entry(s), but none declares the {protocol} protocol. Add a model with this protocol in the AI settings.',
            { count: providers.length, protocol },
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void commands.executeCommand(ManageModelsAction.ID)}
        >
          {localize('agentSettings.auth.provider.configure', 'Open AI settings…')}
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className={styles['providerPickerRow']}>
        <select
          className={styles['providerSelect']}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {localize('agentSettings.auth.form.provider.none', 'Select a provider…')}
          </option>
          <option value={AGENT_SUBSCRIPTION_AUTH}>{subscriptionLabel}</option>
          {options.map((p) => {
            const isIncompatible = incompatible !== undefined && p.id === incompatible.id
            return (
              <option key={p.id} value={p.id}>
                {p.label ?? p.id}
                {isIncompatible
                  ? ` (${localize('agentSettings.auth.provider.incompatibleOption', 'incompatible')})`
                  : ''}
              </option>
            )
          })}
        </select>
        <VerifyDot state={verify} />
        <Button
          size="sm"
          variant="ghost"
          busy={verify.kind === 'checking'}
          disabled={resolved === undefined}
          onClick={test}
        >
          {localize('agentSettings.auth.provider.test', 'Test')}
        </Button>
      </div>
      {incompatible !== undefined ? (
        <div className={styles['deriveError']}>
          {localize(
            'agentSettings.auth.provider.incompatible',
            'This provider entry does not declare the {protocol} protocol. Add a model with this protocol in the AI settings.',
            { protocol },
          )}
        </div>
      ) : (
        children(resolved)
      )}
    </>
  )
}

/** Error shown when a provider can't produce a CLI credential (missing key or URL). */
export function DerivationError({ missing }: { readonly missing: 'apiKey' | 'baseUrl' }) {
  const message =
    missing === 'apiKey'
      ? localize(
          'agentSettings.auth.provider.missingApiKey',
          'This provider has no API key. Set it in the AI settings (Model configuration → Providers).',
        )
      : localize(
          'agentSettings.auth.provider.missingBaseUrl',
          'This provider has no base URL. Set it in the AI settings (Model configuration → Providers).',
        )
  return <div className={styles['deriveError']}>{message}</div>
}

function VerifyDot({ state }: { readonly state: VerifyState }) {
  if (state.kind === 'checking') {
    return (
      <span
        className={styles['verifyDotWrap']}
        data-tooltip={localize('agentSettings.auth.provider.checking', 'Checking…')}
      >
        <Spinner size={11} />
      </span>
    )
  }
  const info =
    state.kind === 'ok'
      ? {
          className: styles['verifyDotOk'],
          tooltip: localize('agentSettings.auth.provider.ok', 'Connected · {count} models', {
            count: state.modelCount,
          }),
        }
      : state.kind === 'fail'
        ? { className: styles['verifyDotFail'], tooltip: state.error }
        : {
            className: styles['verifyDotIdle'],
            tooltip: localize('agentSettings.auth.provider.idle', 'Not tested'),
          }
  return (
    <span
      className={`${styles['verifyDot'] ?? ''} ${info.className ?? ''}`}
      data-tooltip={info.tooltip}
      data-status={state.kind}
      role="img"
      aria-label={info.tooltip}
    />
  )
}
