// Mirrors the electron-vite layout (out/main/index.js, out/renderer/index.html) so the SAME
// packaging/electron-builder.yml that will package the real app also packages this spike.
const fs = require('fs'), path = require('path')
const out = path.join(__dirname, 'out')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'main'), { recursive: true })
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true })
fs.copyFileSync(path.join(__dirname, 'src', 'main.js'), path.join(out, 'main', 'index.js'))
fs.copyFileSync(path.join(__dirname, 'src', 'index.html'), path.join(out, 'renderer', 'index.html'))
console.log('spike prepared in', out)
