#!/usr/bin/env node
// Hash the final signed, stapled ZIP, never electron-builder's unsigned artifact.
'use strict'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha512(file) {
  const h = createHash('sha512')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8 * 1024 * 1024)
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('base64')
}

function latestMacYml(zip, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`)
  const name = path.basename(zip)
  // GitHub turns spaces in asset names into dots, and electron-updater turns them into dashes: keep none.
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(name)) throw new Error(`the zip name must be plain (letters, digits, . _ -): ${name}`)
  const digest = sha512(zip)
  const size = fs.statSync(zip).size
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${digest}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n')
}

module.exports = { latestMacYml }

if (require.main === module) {
  const [zip, version, out] = process.argv.slice(2)
  if (!zip || !version || !out) {
    console.error('usage: node packaging/latest-mac.js <zip> <version> <out.yml>')
    process.exit(2)
  }
  fs.writeFileSync(out, latestMacYml(zip, version))
  console.log(`wrote ${out}`)
}
