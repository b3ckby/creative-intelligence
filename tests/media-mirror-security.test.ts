import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LocalContentAddressedMediaStore } from '../src/media/content-addressed-store.ts'
import { MediaFetchError, SafeMediaFetcher, type MediaHttpResponse } from '../src/media/safe-media-fetcher.ts'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])

function response(status: number, body: Uint8Array = jpeg, headers: Record<string, string> = { 'content-type': 'image/jpeg' }): MediaHttpResponse {
  return { status, headers, body: (async function * () { yield body })() }
}

function exactCategory(category: string) {
  return (error: unknown): boolean => error instanceof MediaFetchError && error.category === category && error.message === 'Media fetch failed'
}

test('safe media fetch rejects unsafe URL syntax and every non-public resolved address before requesting', async () => {
  let requests = 0
  const fetcher = new SafeMediaFetcher({
    resolve: async () => ['93.184.216.34'],
    request: async () => { requests += 1; return response(200) },
  })
  for (const url of [
    'http://cdn.example.test/a.jpg', 'https://user:secret@cdn.example.test/a.jpg', 'https://cdn.example.test/a.jpg#secret',
    'https://cdn.example.test:444/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg',
  ]) await assert.rejects(() => fetcher.fetch(url, 'image'), exactCategory('address'))

  for (const addresses of [['10.0.0.1'], ['169.254.169.254'], ['127.0.0.1'], ['0.0.0.0'], ['224.0.0.1'], ['::1'], ['fc00::1'], ['fe80::1'], ['2001:2::1'], ['2001:db8::1'], ['3fff::1'], ['93.184.216.34', '10.0.0.1']]) {
    const unsafe = new SafeMediaFetcher({ resolve: async () => addresses, request: async () => { requests += 1; return response(200) } })
    await assert.rejects(() => unsafe.fetch('https://cdn.example.test/a.jpg', 'image'), exactCategory('address'))
  }
  assert.equal(requests, 0)
})

test('safe media fetch pins a validated address and revalidates redirects against DNS rebinding', async () => {
  const events: string[] = []
  const resolutions = new Map([
    ['first.example.test', ['93.184.216.34']],
    ['second.example.test', ['1.1.1.1']],
  ])
  let redirectCancelled = false
  const fetcher = new SafeMediaFetcher({
    resolve: async (hostname) => resolutions.get(hostname) ?? [],
    request: async (url, address) => {
      events.push(`${url.hostname}:${address}`)
      if (url.hostname === 'first.example.test') return {
        ...response(302, Buffer.alloc(0), { location: 'https://second.example.test/final.jpg' }),
        cancel: () => { redirectCancelled = true },
      }
      return response(200)
    },
  }, { maxRedirects: 2 })
  const fetched = await fetcher.fetch('https://first.example.test/start.jpg', 'image')
  assert.equal(redirectCancelled, true)
  assert.equal(fetched.mediaType, 'image/jpeg')
  assert.deepEqual(events, ['first.example.test:93.184.216.34', 'second.example.test:1.1.1.1'])

  resolutions.set('second.example.test', ['127.0.0.1'])
  await assert.rejects(() => fetcher.fetch('https://first.example.test/start.jpg', 'image'), exactCategory('address'))
  const looping = new SafeMediaFetcher({
    resolve: async () => ['93.184.216.34'],
    request: async () => response(302, Buffer.alloc(0), { location: 'https://first.example.test/again' }),
  }, { maxRedirects: 1 })
  await assert.rejects(() => looping.fetch('https://first.example.test/start.jpg', 'image'), exactCategory('redirect'))
})

test('safe media fetch bounds bodies and verifies declared MIME, magic, and expected media kind', async () => {
  const fetcher = (body: Buffer, contentType: string, maxBytes = 32) => new SafeMediaFetcher({
    resolve: async () => ['93.184.216.34'],
    request: async () => response(200, body, { 'content-type': contentType }),
  }, { maxBytes })
  await assert.rejects(() => fetcher(Buffer.alloc(33), 'image/jpeg').fetch('https://cdn.example.test/a.jpg', 'image'), exactCategory('size'))
  await assert.rejects(() => fetcher(Buffer.from('not an image'), 'image/jpeg').fetch('https://cdn.example.test/a.jpg', 'image'), exactCategory('mime'))
  await assert.rejects(() => fetcher(jpeg, 'text/html').fetch('https://cdn.example.test/a.jpg', 'image'), exactCategory('mime'))
  await assert.rejects(() => fetcher(jpeg, 'image/jpeg').fetch('https://cdn.example.test/a.jpg', 'video'), exactCategory('mime'))
  const result = await fetcher(jpeg, 'image/jpeg').fetch('https://cdn.example.test/a.jpg', 'unknown')
  assert.deepEqual(result.bytes, jpeg)
  assert.match(result.checksum, /^[a-f0-9]{64}$/)
})

test('safe media fetch aborts a stalled request at the configured deadline', async () => {
  let aborted = false
  const fetcher = new SafeMediaFetcher({
    resolve: async () => ['93.184.216.34'],
    request: async (_url, _address, signal) => await new Promise<MediaHttpResponse>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }),
  }, { timeoutMs: 100 })
  await assert.rejects(() => fetcher.fetch('https://cdn.example.test/stalled.jpg', 'image'), exactCategory('network'))
  assert.equal(aborted, true)
})

test('local content-addressed store writes atomically, deduplicates, and rejects unbounded paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'creative-media-'))
  try {
    const store = new LocalContentAddressedMediaStore(root)
    const [first, second] = await Promise.all([
      store.put(jpeg, 'image/jpeg'),
      store.put(jpeg, 'image/jpeg'),
    ])
    assert.deepEqual(first, second)
    assert.equal(first.reference, `/media/sha256/${first.checksum}`)
    assert.deepEqual(await store.read(first.checksum), { bytes: jpeg, mediaType: 'image/jpeg', byteSize: jpeg.length })
    const stored = await readFile(join(root, 'sha256', first.checksum.slice(0, 2), first.checksum))
    assert.deepEqual(stored, jpeg)
    for (const key of ['../etc/passwd', 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}/extra`]) {
      await assert.rejects(() => store.read(key), /Invalid media checksum/)
    }
    await assert.rejects(() => store.put(jpeg, 'video/mp4'), /metadata conflict/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
