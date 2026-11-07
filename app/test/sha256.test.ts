// The phone page signs every request with shared/sha256.ts; the computer checks with node:crypto. A wrong digest
// means every phone is refused, so the page's hash is held to the published vectors and to node:crypto.
import { createHash, createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fromHex, hmacSha256, sha256, toHex, utf8 } from '../src/shared/sha256'

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))

describe('sha256', () => {
  // FIPS 180-4 examples, plus the padding edges: 55 and 56 bytes straddle the one-block limit, 64 fills a block.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']
  ])('matches the published digest of %j', (input, digest) => {
    expect(toHex(sha256(utf8(input)))).toBe(digest)
  })

  it.each([55, 56, 63, 64, 65, 1000])('matches node:crypto at %i bytes', (n) => {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255)
    expect(toHex(sha256(b))).toBe(createHash('sha256').update(b).digest('hex'))
  })
})

describe('hmacSha256', () => {
  // RFC 4231 test cases 1, 2, 6 (a key longer than the block) and 7.
  it.each([
    ['0b'.repeat(20), Buffer.from('Hi There').toString('hex'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [Buffer.from('Jefe').toString('hex'), Buffer.from('what do ya want for nothing?').toString('hex'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['aa'.repeat(131), Buffer.from('Test Using Larger Than Block-Size Key - Hash Key First').toString('hex'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    [
      'aa'.repeat(131),
      Buffer.from('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.').toString('hex'),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'
    ]
  ])('matches RFC 4231 for key %s', (key, data, mac) => {
    expect(toHex(hmacSha256(hex(key), hex(data)))).toBe(mac)
  })

  it('agrees with node:crypto on any key and message', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 300 }), (key, data) => {
        expect(toHex(hmacSha256(key, data))).toBe(createHmac('sha256', key).update(data).digest('hex'))
      }),
      { numRuns: 300 }
    )
  })
})

describe('fromHex', () => {
  it('reads exactly the asked length of lowercase hex, and nothing else', () => {
    expect(Array.from(fromHex('00ff10', 3)!)).toEqual([0, 255, 16])
    expect(fromHex('00ff1', 3)).toBeNull()
    expect(fromHex('00FF10', 3)).toBeNull()
    expect(fromHex('00fg10', 3)).toBeNull()
  })
})
