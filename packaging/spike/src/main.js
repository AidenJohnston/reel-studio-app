// Packaging spike main process. Mirrors how the real app will locate and spawn the bundled engine.
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const isWin = process.platform === 'win32'
const plat = isWin ? 'win-x64' : 'mac-arm64'
const argv = process.argv.slice(1)
const flag = (n) => argv.includes(n)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
// Same variable as the real app: packaging/test-mac-install.sh runs the spike with a test profile.
if (process.env.REELSTUDIO_USER_DATA) app.setPath('userData', process.env.REELSTUDIO_USER_DATA)

// Packaged: <resources>/{python,ffmpeg,engine}. Dev: packaging/runtime/<plat> + the stub engine.
function locations() {
  if (app.isPackaged) {
    const r = process.resourcesPath
    return {
      python: path.join(r, 'python', isWin ? 'python.exe' : 'bin/python3'),
      ffmpeg: path.join(r, 'ffmpeg', isWin ? 'ffmpeg.exe' : 'ffmpeg'),
      ffprobe: path.join(r, 'ffmpeg', isWin ? 'ffprobe.exe' : 'ffprobe'),
      engine: path.join(r, 'engine'),
      wav: path.join(r, 'engine', 'reelengine', 'hello.wav'),
    }
  }
  const pk = path.join(__dirname, '..', '..', '..', '..') // packaging/spike/out/main -> packaging/..
  const rt = path.join(pk, 'packaging', 'runtime', plat)
  return {
    python: path.join(rt, 'python', isWin ? 'python.exe' : 'bin/python3'),
    ffmpeg: path.join(rt, 'ffmpeg', isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    ffprobe: path.join(rt, 'ffmpeg', isWin ? 'ffprobe.exe' : 'ffprobe'),
    engine: path.join(pk, 'packaging', 'spike', 'engine-stub'),
    wav: path.join(pk, 'packaging', 'spike', 'engine-stub', 'reelengine', 'hello.wav'),
  }
}

function runSelfTest(onLine) {
  const L = locations()
  const userData = app.getPath('userData')
  const env = {
    ...process.env,
    PYTHONPATH: L.engine,
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    REELENGINE_FFMPEG: L.ffmpeg,
    REELENGINE_FFPROBE: L.ffprobe,
    REELENGINE_MODELS: path.join(userData, 'models'),
    HF_HOME: path.join(userData, 'hf-cache'),
    HF_HUB_DISABLE_TELEMETRY: '1',
    SELFTEST_WAV: L.wav,
    SELFTEST_WORKDIR: path.join(userData, 'selftest work'),
  }
  delete env.PYTHONHOME
  fs.mkdirSync(userData, { recursive: true })
  return new Promise((resolve) => {
    const events = []
    let stderr = ''
    // -s keeps the user's own site-packages out. (Not -I: isolated mode ignores PYTHONPATH, which is how the engine is found.)
    const child = spawn(L.python, ['-s', '-m', 'reelengine.selftest'], { cwd: userData, env, windowsHide: true })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        try { const ev = JSON.parse(line); events.push(ev); onLine && onLine(ev) } catch { events.push({ event: 'garbage', line }) }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000) })
    child.on('error', (e) => resolve({ ok: false, spawnError: String(e), locations: L, events, stderr }))
    child.on('close', (code) => {
      const done = events.find((e) => e.event === 'done')
      resolve({ ok: !!(done && done.result.ok) && code === 0, exitCode: code, locations: L, result: done && done.result, events, stderr })
    })
  })
}

async function selfTestAndQuit() {
  const out = opt('--out') || path.join(app.getPath('userData'), 'selftest-result.json')
  const t0 = Date.now()
  const r = await runSelfTest()
  const payload = {
    ok: r.ok,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    electron: process.versions.electron, node: process.versions.node,
    isPackaged: app.isPackaged, platform: process.platform, arch: process.arch,
    resourcesPath: process.resourcesPath, execPath: process.execPath, userData: app.getPath('userData'),
    ...r,
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(payload, null, 2))
  app.exit(payload.ok ? 0 : 1)
}

app.whenReady().then(() => {
  if (flag('--self-test')) { selfTestAndQuit(); return }
  const win = new BrowserWindow({ width: 760, height: 560, title: 'Reel Studio Spike', webPreferences: { contextIsolation: true, nodeIntegration: false } })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
})
app.on('window-all-closed', () => app.quit())
