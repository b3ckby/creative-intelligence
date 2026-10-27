import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildApi } from '../src/http/build-api.ts'
import { normalizeManualBriefInput } from '../src/briefs/brief-service.ts'
import { normalizeCanonicalText } from '../src/domain/validation.ts'
import { API_CONTRACTS, OPERATIONAL_CONTRACTS, generateOpenApiDocument, schemaFor } from '../src/http/schemas.ts'

const EXPECTED_OPERATIONS = [
  'POST /organizations',
  'POST /organizations/{organizationId}/members',
  'POST /organizations/{organizationId}/products',
  'GET /organizations/{organizationId}/products',
  'GET /organizations/{organizationId}/products/{productId}',
  'POST /organizations/{organizationId}/products/{productId}/competitors',
  'GET /organizations/{organizationId}/products/{productId}/competitors',
  'GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}',
  'POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/manual-meta',
  'GET /organizations/{organizationId}/competitors/{competitorId}/ads',
  'GET /organizations/{organizationId}/ads',
  'POST /organizations/{organizationId}/products/{productId}/briefs/from-ad',
  'POST /organizations/{organizationId}/products/{productId}/briefs',
  'GET /organizations/{organizationId}/products/{productId}/briefs',
  'GET /organizations/{organizationId}/briefs/{briefId}',
  'POST /organizations/{organizationId}/products/{productId}/iteration-map/analyze',
].sort()

test('OpenAPI contracts enumerate every business route with unique operation IDs and strict schemas', () => {
  const operations = API_CONTRACTS.map(({ method, openapiPath }) => `${method} ${openapiPath}`).sort()
  assert.deepEqual(operations, EXPECTED_OPERATIONS)
  assert.equal(new Set(API_CONTRACTS.map(({ operationId }) => operationId)).size, API_CONTRACTS.length)
  for (const contract of API_CONTRACTS) {
    assert.deepEqual(contract.schema.security, [{ bearerAuth: [] }], contract.operationId)
    assert.ok(contract.schema.response[400], contract.operationId)
    assert.ok(contract.schema.response[401], contract.operationId)
    assert.ok(contract.schema.response[500], contract.operationId)
    if (contract.schema.body && contract.schema.body.type === 'object') {
      assert.equal(contract.schema.body.additionalProperties, false, contract.operationId)
    }
  }
})

test('generated OpenAPI is deterministic, provider-neutral, and contains no deployment secrets', async () => {
  const document = generateOpenApiDocument()
  assert.equal(document.openapi, '3.1.0')
  assert.deepEqual(document.components.securitySchemes, {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  })
  assert.deepEqual(Object.keys(document.paths).sort(), [
    ...new Set(EXPECTED_OPERATIONS.map((entry) => entry.slice(entry.indexOf(' ') + 1))),
    '/health/live',
    '/health/ready',
  ].sort())
  assert.equal(OPERATIONAL_CONTRACTS.length, 2)
  assert.deepEqual(document.paths['/health/live']?.get?.security, [])
  const readinessOperation = document.paths['/health/ready']?.get as { responses?: Record<string, unknown> } | undefined
  assert.deepEqual(readinessOperation?.responses?.['503'], {
    description: 'Service unavailable',
    content: { 'application/json': { schema: OPERATIONAL_CONTRACTS[1]?.schema.response[503] } },
  })
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  assert.doesNotMatch(serialized, /identity\.example|postgresql:|cursor-signing|client_secret|x-user-id/i)
  assert.equal(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'), serialized)
})

test('Fastify validates routes with the exact schemas used to generate OpenAPI', async () => {
  let observedSchema: unknown
  const app = buildApi({
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => { throw new Error('not used') },
    },
    createId: () => 'unused',
    now: () => new Date('2026-10-27T00:00:00.000Z'),
    authenticate: async (request) => {
      observedSchema = request.routeOptions.schema
      return 'user-1'
    },
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
  })
  const response = await app.inject({ method: 'GET', url: '/organizations/org-1/products' })
  assert.equal(response.statusCode, 500)
  assert.equal(observedSchema, schemaFor('listProducts'))
  await app.close()
})

test('request contracts match domain boundaries for normalized text, URLs, dates, and iteration axes', () => {
  const byId = Object.fromEntries(API_CONTRACTS.map((contract) => [contract.operationId, contract]))
  const manualRecord = (((byId.importManualMetaAds?.schema.body as any).properties.records.items)) as any
  assert.equal(manualRecord.properties.mediaUrls.maxItems, 50)
  assert.equal(manualRecord.properties.mediaUrls.uniqueItems, true)
  assert.equal(manualRecord.properties.sourceUrl.format, 'canonical-https-url')
  assert.equal(manualRecord.properties.startedAt.format, 'parseable-javascript-date')

  const axes = ((byId.analyzeIterationMap?.schema.body as any).properties.axes.properties) as Record<string, any>
  for (const axis of Object.values(axes)) {
    assert.equal(axis.minItems, 1)
    assert.equal(axis.maxItems, 50)
    const itemPattern = new RegExp(axis.items.pattern)
    assert.match(` ${'a'.repeat(100)} `, itemPattern)
    assert.doesNotMatch('a'.repeat(101), itemPattern)
  }

  const organizationName = ((byId.createOrganization?.schema.body as any).properties.name) as any
  const unicodeBoundary = '😀'.repeat(200)
  assert.match(unicodeBoundary, new RegExp(organizationName.pattern, 'u'))
  assert.equal(normalizeCanonicalText(unicodeBoundary, 'Organization name', { maxLength: 200 }), unicodeBoundary)

  const brief = normalizeManualBriefInput({
    organizationId: 'org-1', productId: 'product-1', title: '😀'.repeat(500), hook: '',
    dimensions: { audience: '😀'.repeat(100), market: 'm', angle: 'a', format: 'f' },
  })
  assert.equal([...brief.title].length, 500)
  assert.equal([...brief.dimensions.audience].length, 100)

  assert.equal(manualRecord.anyOf.length, 2)
  assert.equal(((byId.analyzeIterationMap?.schema.body as any).properties.axes)['x-maxCartesianProduct'], 10_000)
})

test('cross-field request invariants reject before repositories are reached', async () => {
  const app = buildApi({
    pool: {
      query: async () => { throw new Error('repository must not be reached') },
      connect: async () => { throw new Error('repository must not be reached') },
    },
    createId: () => 'unused',
    now: () => new Date('2026-10-27T00:00:00.000Z'),
    authenticate: async () => 'user-1',
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
  })
  const manual = await app.inject({
    method: 'POST',
    url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta',
    payload: { records: [{
      externalId: 'ad-1', advertiserName: 'Advertiser', body: '', startedAt: '2026-10-01',
      isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/ad',
    }] },
  })
  assert.equal(manual.statusCode, 400)

  const values = Array.from({ length: 11 }, (_, index) => `v-${index}`)
  const iteration = await app.inject({
    method: 'POST',
    url: '/organizations/org-1/products/product-1/iteration-map/analyze',
    payload: { axes: { audience: values, market: values.slice(0, 10), angle: values.slice(0, 10), format: values.slice(0, 10) } },
  })
  assert.equal(iteration.statusCode, 400)
  await app.close()
})

test('generated query parameters expose semantic integer and boolean types', () => {
  const document = generateOpenApiDocument()
  const listProducts = document.paths['/organizations/{organizationId}/products']?.get as { parameters?: Array<any> }
  const parameters = Object.fromEntries((listProducts.parameters ?? []).map((parameter) => [parameter.name, parameter]))
  assert.equal(parameters.limit.schema.type, 'integer')
  assert.equal(parameters.limit.schema.minimum, 1)
  assert.equal(parameters.limit.schema.maximum, 100)
  assert.equal(parameters.includeArchived.schema.type, 'boolean')
})

test('operation contracts list only endpoint-reachable error statuses', () => {
  const byId = Object.fromEntries(API_CONTRACTS.map((contract) => [contract.operationId, contract]))
  assert.deepEqual(Object.keys(byId.createOrganization!.schema.response).map(Number).sort((a, b) => a - b), [201, 400, 401, 409, 413, 415, 500])
  assert.deepEqual(Object.keys(byId.listProducts!.schema.response).map(Number).sort((a, b) => a - b), [200, 400, 401, 403, 500])
  assert.deepEqual(Object.keys(byId.getProduct!.schema.response).map(Number).sort((a, b) => a - b), [200, 400, 401, 403, 404, 500])
  for (const operationId of ['createBriefFromAd', 'createManualBrief', 'listBriefs', 'getBrief', 'analyzeIterationMap']) {
    assert.equal(byId[operationId]!.schema.response[403], undefined, operationId)
  }
  assert.ok(OPERATIONAL_CONTRACTS[0]!.schema.response[400])
  assert.ok(OPERATIONAL_CONTRACTS[1]!.schema.response[400])
})

test('package lifecycle checks generated contract drift and API guide documents public semantics', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts?: Record<string, string>
  }
  assert.equal(manifest.scripts?.['generate:openapi'], 'tsx scripts/generate-openapi.ts')
  assert.equal(manifest.scripts?.['check:openapi'], 'tsx scripts/check-openapi.ts')
  assert.match(manifest.scripts?.check ?? '', /npm run check:openapi/)

  const guide = await readFile(new URL('../docs/API.md', import.meta.url), 'utf8')
  for (const heading of ['Authentication', 'Pagination', 'Errors', 'Endpoints', 'Operational endpoints']) {
    assert.match(guide, new RegExp(`^## ${heading}$`, 'm'))
  }
  assert.doesNotMatch(guide, /x-user-id|client_secret|postgresql:\/\//i)
})
