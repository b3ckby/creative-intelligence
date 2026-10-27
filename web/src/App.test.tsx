// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { CreativeIntelligenceApi } from './api.ts'
import { App } from './App.tsx'

const api: CreativeIntelligenceApi = {
  listProducts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  createProduct: vi.fn(), listCompetitors: vi.fn(), createCompetitor: vi.fn(), syncApifyMetaAds: vi.fn(), listAds: vi.fn(), listBriefs: vi.fn(),
  createManualBrief: vi.fn(), createBriefFromAd: vi.fn(), analyzeIterationMap: vi.fn(),
}

afterEach(() => { cleanup(); localStorage.clear() })

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
