// Runs electron-vite with a clean environment. Some terminals (editors built on Electron) export
// ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node and the app never opens.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const bin = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
