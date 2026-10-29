// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AdCreative } from './Workspace.tsx'
import type { CompetitorAd } from './types.ts'

function ad(media: NonNullable<CompetitorAd['media']> | null): CompetitorAd {
  return {
    id: 'ad', organizationId: 'org', productId: 'product', competitorId: 'competitor', providerName: 'apify-meta-ads',
    platform: 'meta', externalId: 'external', advertiserName: 'Advertiser', body: 'Body', callToAction: null,
    adType: 'carousel', startedAt: '2026-01-01T00:00:00.000Z', isActive: true, media,
    mediaUrls: [], sourceUrl: 'https://example.com/ad', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('durable creative media rendering', () => {
  it('prefers mirrored references while preserving structured order and duplicate source positions', () => {
    render(<AdCreative ad={ad([
      { kind: 'image', sourceUrl: 'https://cdn.example.com/shared.jpg', mirroredUrl: `/media/sha256/${'a'.repeat(64)}`, posterUrl: null, cardIndex: 0, order: 0 },
      { kind: 'image', sourceUrl: 'https://cdn.example.com/shared.jpg', mirroredUrl: `/media/sha256/${'b'.repeat(64)}`, posterUrl: null, cardIndex: 1, order: 1 },
    ])} />)
    const images = screen.getAllByRole('img') as HTMLImageElement[]
    expect(images.map((image) => image.src)).toEqual([
      `http://localhost:3000/media/sha256/${'a'.repeat(64)}`,
      `http://localhost:3000/media/sha256/${'b'.repeat(64)}`,
    ])
  })

  it('serves a mirrored legacy video using the canonical slot media kind', () => {
    const legacy = ad(null)
    legacy.advertiserName = 'Legacy advertiser'
    legacy.adType = 'video'
    legacy.mediaUrls = ['https://video-cdn.fbcdn.net/ad.mp4']
    legacy.mirroredMediaUrls = [`/media/sha256/${'c'.repeat(64)}`]
    render(<AdCreative ad={legacy} />)
    const video = screen.getByLabelText('Legacy advertiser ad creative') as HTMLVideoElement
    expect(video.querySelector('source')?.src).toBe(`http://localhost:3000/media/sha256/${'c'.repeat(64)}`)
  })

  it('falls back to canonical provider media and poster until a mirror succeeds', () => {
    render(<AdCreative ad={ad([{ kind: 'video', sourceUrl: 'https://video-cdn.fbcdn.net/ad.mp4', posterUrl: 'https://cdn.fbcdn.net/poster.jpg', cardIndex: null, order: 0 }])} />)
    const video = screen.getByLabelText('Advertiser ad creative') as HTMLVideoElement
    expect(video.querySelector('source')?.src).toBe('https://video-cdn.fbcdn.net/ad.mp4')
    expect(video.poster).toBe('https://cdn.fbcdn.net/poster.jpg')
  })
})
