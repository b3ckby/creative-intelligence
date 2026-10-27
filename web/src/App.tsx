import { useState, type FormEvent } from 'react'

import { ApiError, createApiClient, exchangeStagingPassword, type ApiConnection, type CreativeIntelligenceApi, type StagingSession } from './api.ts'
import { Workspace } from './Workspace.tsx'

interface SimpleLoginConfig {
  apiBaseUrl: string
}

interface AppProps {
  clientFactory?: (connection: ApiConnection) => CreativeIntelligenceApi
  simpleLogin?: SimpleLoginConfig
  passwordLogin?: (apiBaseUrl: string, password: string) => Promise<StagingSession>
}

const API_URL_KEY = 'creative-intelligence.api-url'
const ORGANIZATION_KEY = 'creative-intelligence.organization-id'
const ENVIRONMENT_SIMPLE_LOGIN: SimpleLoginConfig | undefined = import.meta.env.VITE_SIMPLE_LOGIN === 'true'
  ? { apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '' }
  : undefined

export function App({
  clientFactory = createApiClient,
  simpleLogin = ENVIRONMENT_SIMPLE_LOGIN,
  passwordLogin = exchangeStagingPassword,
}: AppProps) {
  const [client, setClient] = useState<CreativeIntelligenceApi | null>(null)
  const [organizationLabel, setOrganizationLabel] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      let connection: ApiConnection
      if (simpleLogin) {
        const password = formValue(data, 'password')
        setPending(true)
        const session = await passwordLogin(simpleLogin.apiBaseUrl, password)
        connection = { apiBaseUrl: simpleLogin.apiBaseUrl, ...session }
      } else {
        connection = {
          apiBaseUrl: formText(data, 'apiBaseUrl'),
          organizationId: formText(data, 'organizationId'),
          accessToken: formText(data, 'accessToken'),
        }
        remember(API_URL_KEY, connection.apiBaseUrl)
        remember(ORGANIZATION_KEY, connection.organizationId)
      }
      const nextClient = clientFactory(connection)
      setOrganizationLabel(connection.organizationId)
      setClient(nextClient)
    } catch (reason) {
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Connection settings are invalid')
    } finally {
      if (simpleLogin) form.reset()
      setPending(false)
    }
  }

  if (client) {
    return <Workspace api={client} organizationLabel={organizationLabel} onDisconnect={() => setClient(null)} />
  }

  return (
    <main className="access-shell">
      <section className="access-manifesto">
        <div className="access-brand"><span>CI</span><strong>Creative<br />Intelligence</strong></div>
        <div className="manifesto-copy">
          <span className="eyebrow">Competitive creative workspace</span>
          <h1>See the field.<br /><em>Find the opening.</em></h1>
          <p>Organize competitive ads, translate evidence into briefs, and make creative coverage visible.</p>
        </div>
        <div className="manifesto-index"><span>Products</span><span>Competitors</span><span>Ads</span><span>Briefs</span><span>Map</span></div>
      </section>
      <section className="access-panel">
        <div className="access-form-wrap">
          <span className="eyebrow">Secure connection</span>
          <h2>Enter the workspace</h2>
          <p className="access-note">{simpleLogin
            ? 'Enter the staging password. Your access token stays in memory and is cleared when this page closes or disconnects.'
            : 'Your bearer token stays in memory and is cleared when this page closes or disconnects.'}</p>
          {error && <div className="message error" role="alert">{error}</div>}
          <form className="form-stack access-form" onSubmit={connect}>
            {simpleLogin ? (
              <label>Password<input name="password" aria-label="Password" type="password" autoComplete="new-password" maxLength={1_024} required autoFocus /></label>
            ) : (
              <>
                <label>API base URL<input name="apiBaseUrl" aria-label="API base URL" type="url" defaultValue={recall(API_URL_KEY)} placeholder="https://api.example.com" /></label>
                <label>Organization ID<input name="organizationId" aria-label="Organization ID" defaultValue={recall(ORGANIZATION_KEY)} maxLength={256} required /></label>
                <label>Access token<input name="accessToken" aria-label="Access token" type="password" autoComplete="off" required /></label>
              </>
            )}
            <button className="primary-button access-submit" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Enter workspace'}</button>
          </form>
          <small className="privacy-note">Authentication is sent only as an Authorization: Bearer header.</small>
        </div>
      </section>
    </main>
  )
}

function formValue(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === 'string' ? value : ''
}

function formText(data: FormData, name: string): string {
  return formValue(data, name).trim()
}

function remember(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* storage can be unavailable */ }
}

function recall(key: string): string {
  try { return window.localStorage.getItem(key) ?? '' } catch { return '' }
}
