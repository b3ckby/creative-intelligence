import { useState, type FormEvent } from 'react'

import { ApiError, createApiClient, type ApiConnection, type CreativeIntelligenceApi } from './api.ts'
import { Workspace } from './Workspace.tsx'

interface AppProps {
  clientFactory?: (connection: ApiConnection) => CreativeIntelligenceApi
}

const API_URL_KEY = 'creative-intelligence.api-url'
const ORGANIZATION_KEY = 'creative-intelligence.organization-id'

export function App({ clientFactory = createApiClient }: AppProps) {
  const [client, setClient] = useState<CreativeIntelligenceApi | null>(null)
  const [organizationLabel, setOrganizationLabel] = useState('')
  const [error, setError] = useState('')

  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const data = new FormData(event.currentTarget)
    const connection = {
      apiBaseUrl: formText(data, 'apiBaseUrl'),
      organizationId: formText(data, 'organizationId'),
      accessToken: formText(data, 'accessToken'),
    }
    try {
      const nextClient = clientFactory(connection)
      remember(API_URL_KEY, connection.apiBaseUrl)
      remember(ORGANIZATION_KEY, connection.organizationId)
      setOrganizationLabel(connection.organizationId)
      setClient(nextClient)
    } catch (reason) {
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Connection settings are invalid')
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
          <p className="access-note">Your bearer token stays in memory and is cleared when this page closes or disconnects.</p>
          {error && <div className="message error" role="alert">{error}</div>}
          <form className="form-stack access-form" onSubmit={connect}>
            <label>API base URL<input name="apiBaseUrl" aria-label="API base URL" type="url" defaultValue={recall(API_URL_KEY)} placeholder="https://api.example.com" /></label>
            <label>Organization ID<input name="organizationId" aria-label="Organization ID" defaultValue={recall(ORGANIZATION_KEY)} maxLength={256} required /></label>
            <label>Access token<input name="accessToken" aria-label="Access token" type="password" autoComplete="off" required /></label>
            <button className="primary-button access-submit" type="submit">Enter workspace</button>
          </form>
          <small className="privacy-note">Authentication is sent only as an Authorization: Bearer header.</small>
        </div>
      </section>
    </main>
  )
}

function formText(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function remember(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* storage can be unavailable */ }
}

function recall(key: string): string {
  try { return window.localStorage.getItem(key) ?? '' } catch { return '' }
}
