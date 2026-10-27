const MAX_NESTING_DEPTH = 64
const MAX_OBJECT_KEYS = 1_000
const MAX_TOTAL_KEYS = 10_000
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

type Container =
  | { type: 'array' }
  | { type: 'object'; expectingKey: boolean; keys: Set<string> }

/**
 * Performs bounded policy inspection before the native parser can allocate a
 * value graph. The lexical pass is iterative and visits each source character
 * a constant number of times; JSON.parse remains responsible for grammar and
 * value construction only after the source passes the policy bounds.
 */
export function parseStrictJson(source: string): unknown {
  inspectObjectKeys(source)
  return JSON.parse(source) as unknown
}

function inspectObjectKeys(source: string): void {
  const stack: Container[] = []
  let totalKeys = 0

  for (let index = 0; index < source.length;) {
    const character = source[index]
    if (character === '"') {
      const container = stack.at(-1)
      const isObjectKey = container?.type === 'object' && container.expectingKey
      const scanned = scanString(source, index, isObjectKey)
      index = scanned.end
      if (isObjectKey && scanned.decoded !== undefined) {
        if (DANGEROUS_KEYS.has(scanned.decoded) || container.keys.has(scanned.decoded)) {
          throw new SyntaxError('Unsafe or duplicate JSON key')
        }
        container.keys.add(scanned.decoded)
        totalKeys += 1
        if (container.keys.size > MAX_OBJECT_KEYS || totalKeys > MAX_TOTAL_KEYS) {
          throw new SyntaxError('JSON has too many keys')
        }
        container.expectingKey = false
      }
      continue
    }

    if (character === '{') {
      stack.push({ type: 'object', expectingKey: true, keys: new Set() })
      if (stack.length > MAX_NESTING_DEPTH) throw new SyntaxError('JSON nesting is too deep')
    } else if (character === '[') {
      stack.push({ type: 'array' })
      if (stack.length > MAX_NESTING_DEPTH) throw new SyntaxError('JSON nesting is too deep')
    } else if (character === '}' || character === ']') {
      stack.pop()
    } else if (character === ',') {
      const container = stack.at(-1)
      if (container?.type === 'object') container.expectingKey = true
    }
    index += 1
  }
}

function scanString(source: string, start: number, decode: boolean): { end: number; decoded?: string } {
  const decoded: string[] | undefined = decode ? [] : undefined
  let validForPolicy = true
  let index = start + 1

  while (index < source.length) {
    const character = source[index]
    if (character === '"') {
      return {
        end: index + 1,
        ...(decoded !== undefined && validForPolicy ? { decoded: decoded.join('') } : {}),
      }
    }
    if (character !== '\\') {
      decoded?.push(character!)
      index += 1
      continue
    }

    const escape = source[index + 1]
    if (escape === undefined) return { end: source.length }
    if (escape === 'u') {
      const hexadecimal = source.slice(index + 2, index + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hexadecimal)) {
        decoded?.push(String.fromCharCode(Number.parseInt(hexadecimal, 16)))
        index += 6
      } else {
        validForPolicy = false
        index += Math.min(6, source.length - index)
      }
      continue
    }
    const escapedCharacters: Readonly<Record<string, string>> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    }
    const decodedEscape = escapedCharacters[escape]
    if (decodedEscape === undefined) validForPolicy = false
    else decoded?.push(decodedEscape)
    index += 2
  }
  return { end: source.length }
}
