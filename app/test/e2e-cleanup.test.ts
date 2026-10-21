import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

for (const keep of ['0', '1']) {
  it(`cleans up the e2e worker folder unless KEEP_E2E_TMP=1 (${keep})`, () => {
    const helper = resolve(__dirname, '../e2e/helpers.ts')
    const base = execFileSync(process.execPath, ['-e', `
      const { readFileSync } = require('node:fs')
      const { Module } = require('node:module')
      const { dirname } = require('node:path')
      const ts = require('typescript')
      const file = process.argv[1]
      const mod = new Module(file)
      mod.filename = file
      mod.paths = Module._nodeModulePaths(dirname(file))
      mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, file)
      process.stdout.write(mod.exports.BASE)
    `, helper], { env: { ...process.env, KEEP_E2E_TMP: keep }, encoding: 'utf8' })
    try {
      expect(existsSync(base)).toBe(keep === '1')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}
