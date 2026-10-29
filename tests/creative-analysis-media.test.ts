import assert from 'node:assert/strict'
import test from 'node:test'

import { creativeInputFingerprint, prepareCreativeMedia, type CreativeMediaDescriptor } from '../src/creative-analysis/creative-analysis-service.ts'
import { GeminiCreativeTagger } from '../src/creative-analysis/gemini-creative-tagger.ts'

const copy = { advertiserName: 'Example', body: 'Save time', callToAction: 'LEARN_MORE' }
const checksumA = 'a'.repeat(64)
const checksumB = 'b'.repeat(64)

function media(overrides: Partial<CreativeMediaDescriptor> = {}): CreativeMediaDescriptor {
  return { slotKind: 'structured_source', position: 0, checksum: checksumA, mediaType: 'image/png', byteSize: 3, bytes: Buffer.from([1, 2, 3]), ...overrides }
}

test('media fingerprint includes deterministic ordered slots and copy but excludes mutable timestamps', () => {
  const ordered = [media(), media({ slotKind: 'structured_poster', position: 1, checksum: checksumB })]
  const reordered = [ordered[1]!, ordered[0]!]
  assert.equal(creativeInputFingerprint(copy, ordered), creativeInputFingerprint(copy, reordered))
  assert.notEqual(creativeInputFingerprint(copy, ordered), creativeInputFingerprint(copy, [ordered[0]!]))
  assert.notEqual(creativeInputFingerprint(copy, ordered), creativeInputFingerprint({ ...copy, body: 'Changed' }, ordered))
})

test('trusted media preparation orders slots and enforces count and aggregate byte bounds before encoding', () => {
  const prepared = prepareCreativeMedia([
    media({ slotKind: 'structured_poster', position: 1, checksum: checksumB, bytes: Buffer.from([4]), byteSize: 1 }),
    media(),
  ], { maxCount: 2, maxAggregateBytes: 4 })
  assert.deepEqual(prepared.map((item) => item.checksum), [checksumA, checksumB])
  assert.throws(() => prepareCreativeMedia([media(), media({ position: 1 }), media({ position: 2 })], { maxCount: 2, maxAggregateBytes: 100 }), /bounds/u)
  assert.throws(() => prepareCreativeMedia([media({ byteSize: 5, bytes: Buffer.alloc(5) })], { maxCount: 2, maxAggregateBytes: 4 }), /bounds/u)
  assert.throws(() => prepareCreativeMedia([media({ mediaType: 'video/mp4' as 'image/png' })], { maxCount: 2, maxAggregateBytes: 100 }), /MIME/u)
})

test('Gemini multimodal payload sends bounded inline mirrored images in deterministic order without checksums or URLs', async () => {
  let requestBody: Record<string, unknown> | undefined
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test', maxMediaCount: 2, maxMediaBytes: 10 }, {
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', onScreenText: 'Save time', visualSummary: 'Blue product card', funnelStage: 'consideration', confidence: 0.82 }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await tagger.analyze({ ...copy, mode: 'media', media: [media()] })
  const serialized = JSON.stringify(requestBody)
  assert.match(serialized, /inlineData/u)
  assert.match(serialized, /AQID/u)
  assert.equal(serialized.includes(checksumA), false)
  assert.equal(serialized.includes('http'), false)
})

test('copy-only Gemini mode is explicit and cannot claim visual observation or on-screen text', async () => {
  let prompt = ''
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test' }, {
    fetch: async (_url, init) => {
      prompt = String(init?.body)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-only inference; no trusted media was analyzed.', funnelStage: 'consideration', confidence: 0.5 }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await tagger.analyze({ ...copy, mode: 'copy_only', media: [] })
  assert.equal('onScreenText' in result, false)
  assert.match(prompt, /COPY_ONLY/u)
  assert.match(result.visualSummary, /no trusted media was analyzed/u)
})
