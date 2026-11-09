import type { ConnectionDiagnosis } from '../socket/connectionDiagnosis.js'
import { strings } from '../strings.js'

export interface ConnectionDiagnosticProps {
  readonly diagnosis: ConnectionDiagnosis | undefined
  readonly onRetryConnection: () => void
  readonly onRecheck: () => void
}

interface DiagnosisCopy {
  readonly title: string
  readonly body?: string
  readonly hints?: readonly string[]
  readonly canRetryConnection: boolean
  readonly canRefresh: boolean
}

function copyFor(diagnosis: ConnectionDiagnosis): DiagnosisCopy {
  switch (diagnosis.kind) {
    case 'ok':
      return {
        title: strings.connectionDiagnosticReachable,
        body: strings.connectionDiagnosticReachableBody,
        hints: [
          strings.connectionDiagnosticHintCertInstall,
          strings.connectionDiagnosticHintHostname,
          strings.connectionDiagnosticHintRefresh,
          strings.connectionDiagnosticHintTailscale,
        ],
        canRetryConnection: true,
        canRefresh: true,
      }
    case 'network-error':
      return {
        title: strings.connectionDiagnosticUnreachable(diagnosis.origin),
        body: strings.connectionDiagnosticUnreachableBody,
        hints: [
          strings.connectionDiagnosticHintSameNetwork,
          strings.connectionDiagnosticHintLocalNetwork,
          strings.connectionDiagnosticHintVpn,
          strings.connectionDiagnosticHintGateway,
          strings.connectionDiagnosticHintCertificate,
        ],
        canRetryConnection: true,
        canRefresh: false,
      }
    case 'forbidden':
      return {
        title: strings.connectionDiagnosticForbidden,
        body: strings.connectionDiagnosticForbiddenBody,
        canRetryConnection: false,
        canRefresh: false,
      }
    case 'not-found':
      return {
        title: strings.connectionDiagnosticNotFound,
        body: strings.connectionDiagnosticNotFoundBody,
        canRetryConnection: false,
        canRefresh: false,
      }
    case 'http-error':
      return {
        title: strings.connectionDiagnosticHttpError(diagnosis.status ?? 0),
        body: strings.connectionDiagnosticHttpErrorBody,
        canRetryConnection: true,
        canRefresh: false,
      }
    case 'invalid-response':
      return {
        title: strings.connectionDiagnosticInvalidResponse,
        body: strings.connectionDiagnosticInvalidResponseBody,
        canRetryConnection: false,
        canRefresh: false,
      }
    case 'protocol-mismatch':
      return {
        title: strings.connectionDiagnosticProtocolMismatch,
        body: strings.connectionDiagnosticProtocolMismatchBody,
        canRetryConnection: false,
        canRefresh: true,
      }
  }
}

/**
 * Explains why the WebSocket keeps failing. The probe behind `diagnosis` hits
 * the same origin over HTTP, so "network-error" means the phone never reached
 * the PC, while "ok" means only the TLS/WS handshake is failing.
 */
export function ConnectionDiagnostic({
  diagnosis,
  onRetryConnection,
  onRecheck,
}: ConnectionDiagnosticProps) {
  if (diagnosis === undefined) return null
  const copy = copyFor(diagnosis)
  return (
    <section
      className={`connection-diagnostic connection-diagnostic--${diagnosis.kind}`}
      aria-label={strings.connectionDiagnosticTitle}
      data-testid="connection-diagnostic"
      data-kind={diagnosis.kind}
    >
      <p className="connection-diagnostic__title">{copy.title}</p>
      {copy.body !== undefined && <p className="connection-diagnostic__body">{copy.body}</p>}
      <p className="connection-diagnostic__origin" data-testid="connection-diagnostic-origin">
        {strings.connectionDiagnosticOrigin}：{diagnosis.origin}
      </p>
      {copy.hints !== undefined && (
        <ul className="connection-diagnostic__hints">
          {copy.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      {diagnosis.kind === 'ok' && (
        <div className="connection-diagnostic__install">
          <a
            className="connection-diagnostic__link"
            href="/api/cert"
            data-testid="connection-diagnostic-ca"
          >
            {strings.connectionDiagnosticInstallCa}
          </a>
          <span>{strings.connectionDiagnosticInstallCaHint}</span>
        </div>
      )}
      <div className="connection-diagnostic__actions">
        {copy.canRetryConnection && (
          <button
            type="button"
            className="button button--primary"
            data-testid="connection-diagnostic-retry"
            onClick={onRetryConnection}
          >
            {strings.connectionDiagnosticRetry}
          </button>
        )}
        <button
          type="button"
          className="button button--secondary"
          data-testid="connection-diagnostic-recheck"
          onClick={onRecheck}
        >
          {strings.connectionDiagnosticRecheck}
        </button>
        {copy.canRefresh && (
          <button
            type="button"
            className="button button--secondary"
            data-testid="connection-diagnostic-refresh"
            onClick={() => window.location.reload()}
          >
            {strings.connectionDiagnosticRefresh}
          </button>
        )}
      </div>
    </section>
  )
}
