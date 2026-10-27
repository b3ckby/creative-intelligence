// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ApiError, type CreativeIntelligenceApi } from './api.ts'
import { App } from './App.tsx'

const api: CreativeIntelligenceApi = {
  listProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  createProduct: vi.fn(), listCompetitors: vi.fn(), createCompetitor: vi.fn(), syncApifyMetaAds: vi.fn(), listAds: vi.fn(), listBriefs: vi.fn(),
  createManualBrief: vi.fn(), createBriefFromAd: vi.fn(), analyzeIterationMap: vi.fn(),
}

afterEach(() => { cleanup(); localStorage.clear() })

it('uses a single password field for configured staging login without persisting credentials', async () => {
  const factory = vi.fn().mockReturnValue(api)
  const passwordLogin = vi.fn().mockResolvedValue({ accessToken: 'signed.jwt.value', organizationId: 'staging-org' })
  render(<App
    clientFactory={factory}
    simpleLogin={{ apiBaseUrl: 'https://staging.example.test/api' }}
    passwordLogin={passwordLogin}
  />)

  expect(screen.queryByLabelText('API base URL')).toBeNull()
  expect(screen.queryByLabelText('Organization ID')).toBeNull()
  expect(screen.queryByLabelText('Access token')).toBeNull()
  const password = screen.getByLabelText('Password') as HTMLInputElement
  expect(password.type).toBe('password')
  expect(password.autocomplete).toBe('new-password')
  fireEvent.change(password, { target: { value: 'staging password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enter workspace' }))

  expect(await screen.findByText('Start with the product.')).toBeTruthy()
  expect(passwordLogin).toHaveBeenCalledWith('https://staging.example.test/api', 'staging password')
  expect(factory).toHaveBeenCalledWith({
    apiBaseUrl: 'https://staging.example.test/api', organizationId: 'staging-org', accessToken: 'signed.jwt.value',
  })
  expect(JSON.stringify(localStorage)).not.toContain('staging password')
  expect(JSON.stringify(localStorage)).not.toContain('signed.jwt.value')
})

it('clears the staging password field after a rejected login', async () => {
  const passwordLogin = vi.fn().mockRejectedValue(new ApiError(401, 'Authentication is required'))
  render(<App
    simpleLogin={{ apiBaseUrl: 'https://staging.example.test/api' }}
    passwordLogin={passwordLogin}
  />)
  const password = screen.getByLabelText('Password') as HTMLInputElement
  fireEvent.change(password, { target: { value: 'wrong password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enter workspace' }))

  expect((await screen.findByRole('alert')).textContent).toBe('Authentication is required')
  expect(password.value).toBe('')
})

it('connects without persisting the bearer token', async () => {
  const factory = vi.fn().mockReturnValue(api)
  render(<App clientFactory={factory} />)

  const token = screen.getByLabelText('Access token') as HTMLInputElement
  expect(token.type).toBe('password')
  fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://api.example.test' } })
  fireEvent.change(screen.getByLabelText('Organization ID'), { target: { value: 'org-1' } })
  fireEvent.change(token, { target: { value: 'signed.jwt.value' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enter workspace' }))

  expect(await screen.findByText('Start with the product.')).toBeTruthy()
  expect(factory).toHaveBeenCalledWith({ apiBaseUrl: 'https://api.example.test', organizationId: 'org-1', accessToken: 'signed.jwt.value' })
  expect(JSON.stringify(localStorage)).not.toContain('signed.jwt.value')
})
