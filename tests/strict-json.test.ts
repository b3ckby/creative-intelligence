import assert from 'node:assert/strict'
import test from 'node:test'

import { parseStrictJson } from '../src/http/strict-json.ts'

test('strict JSON bounds depth and key width before native JSON.parse', () => {
  const originalParse = JSON.parse
  let nativeCalls = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    nativeCalls += 1
    return originalParse(...args)
  }) as typeof JSON.parse
  try {
    assert.throws(() => parseStrictJson(`${'['.repeat(65)}null${']'.repeat(65)}`), /nesting is too deep/i)
    assert.equal(nativeCalls, 0)

    const wide = `{${Array.from({ length: 1_001 }, (_, index) => `"key-${index}":${index}`).join(',')}}`
    assert.throws(() => parseStrictJson(wide), /too many keys/i)
    assert.equal(nativeCalls, 0)
  } finally {
    JSON.parse = originalParse
  }
})

test('strict JSON lexically rejects duplicate and dangerous decoded keys before native parsing', () => {
  const originalParse = JSON.parse
  let nativeCalls = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    nativeCalls += 1
    return originalParse(...args)
  }) as typeof JSON.parse
  try {
    for (const source of [
      '{"safe":1,"s\\u0061fe":2}',
      '{"nested":{"__pr\\u006fto__":true}}',
      '{"nested":{"prot\\u006ftype":true}}',
      '{"nested":{"construct\\u006fr":true}}',
    ]) {
      assert.throws(() => parseStrictJson(source), /unsafe or duplicate JSON key/i)
      assert.equal(nativeCalls, 0)
    }
  } finally {
    JSON.parse = originalParse
  }
})

test('strict JSON delegates grammar and value construction to native parsing only after lexical inspection', () => {
  for (const source of [
    '{"unterminated":"value}',
    '{"bad":"\\x"}',
    '{"a":1,}',
    '{"a":[1,2}',
  ]) assert.throws(() => parseStrictJson(source), SyntaxError)

  assert.deepEqual(parseStrictJson('{"text":"braces {} and escaped \\\" quote","array":[1,true,null]}'), {
    text: 'braces {} and escaped " quote',
    array: [1, true, null],
  })
})

test('strict JSON depth rejection remains linear for a large adversarial body', () => {
  const source = `${'['.repeat(400_000)}null${']'.repeat(400_000)}`
  const started = performance.now()
  assert.throws(() => parseStrictJson(source), /nesting is too deep/i)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 1_000, `lexical rejection took ${elapsed.toFixed(1)}ms`)
})
