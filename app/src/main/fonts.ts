// Font names, read from a font file's own name table (OpenType "name", https://learn.microsoft.com/typography/opentype/spec/name),
// for Library › Fonts. The full name (name ID 4, "Montserrat SemiBold") is what a caption style names and what the
// engine matches first (captions.py font_index reads IDs 1, 4, 6 and 16 the same way); the family (ID 16, else 1)
// groups a family's weights on screen.
export interface FontNames {
  family: string
  full: string
}

/** null when the file is not a TrueType or OpenType font, or has no usable names. */
export function fontNames(data: Buffer): FontNames | null {
  if (data.length < 12) return null
  const tag = data.readUInt32BE(0)
  // 0x00010000 TrueType, 'OTTO' CFF OpenType, 'true' old Apple TrueType; collections (.ttc) are not read
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null
  const tables = data.readUInt16BE(4)
  let off = -1
  let len = 0
  for (let i = 0; i < tables; i++) {
    const at = 12 + 16 * i
    if (at + 16 > data.length) return null
    if (data.toString('latin1', at, at + 4) === 'name') {
      off = data.readUInt32BE(at + 8)
      len = data.readUInt32BE(at + 12)
    }
  }
  if (off < 0 || off + 6 > data.length || off + len > data.length) return null
  const count = data.readUInt16BE(off + 2)
  const strings = off + data.readUInt16BE(off + 4)
  const got = new Map<number, string>()
  for (let i = 0; i < count; i++) {
    const rec = off + 6 + 12 * i
    if (rec + 12 > data.length) break
    const platform = data.readUInt16BE(rec)
    const id = data.readUInt16BE(rec + 6)
    const n = data.readUInt16BE(rec + 8)
    const at = strings + data.readUInt16BE(rec + 10)
    if (![1, 4, 16].includes(id) || at + n > data.length) continue
    // Windows and Unicode platforms store UTF-16BE; Mac Roman is read as Latin-1 (good enough for ASCII names)
    const text = platform === 3 || platform === 0 ? utf16be(data.subarray(at, at + n)) : data.toString('latin1', at, at + n)
    // the Windows English record wins over the others when a font has both
    if (text.trim() && (!got.has(id) || platform === 3)) got.set(id, text.trim())
  }
  const family = got.get(16) ?? got.get(1)
  const full = got.get(4) ?? family
  return family && full ? { family, full } : null
}

function utf16be(b: Buffer): string {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i))
  return s
}
