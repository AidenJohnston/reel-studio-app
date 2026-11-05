// electron-builder afterPack hook: pre-compile Python bytecode inside the packed app, before signing.
// Runs the PACKED interpreter, so it only works when building on the target OS (which is always true:
// Windows build on Windows, macOS build on macOS).
// On Windows with RS_WIN_SIGN=1 it then signs every bundled PE file that has no signature yet (sign-win-resources.ps1),
// before electron-builder signs the app .exe, the uninstaller and the installer itself.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// The same choice electron-builder makes for its own signing step (app-builder-lib out/vm/vm.js): pwsh.exe when it is
// on PATH, otherwise Windows PowerShell. The TrustedSigning module has to be installed for that shell.
function powershellExe() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'pwsh.exe'))) return 'pwsh.exe'
  }
  return 'powershell.exe'
}

function signWindowsResources(appOutDir) {
  // ONE Invoke-TrustedSigning call for the ~160 unsigned .exe/.dll/.pyd/.node files under resources\ and Electron's own
  // DLLs, skipping files Microsoft, the PSF, NVIDIA or Intel already signed. Not `win.signExts`: electron-builder would
  // sign each extraResources file separately while copying it (one PowerShell + signtool process per file, before this
  // hook runs) and would re-sign the already-signed ones (app-builder-lib out/winPackager.js, createTransformerForExtraFiles).
  const script = path.join(__dirname, 'sign-win-resources.ps1')
  console.log(`[after-pack] signing unsigned PE files under ${appOutDir}`)
  execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', appOutDir], { stdio: 'inherit' })
}

exports.default = async function afterPack(context) {
  await compileBytecode(context)
  if (context.electronPlatformName === 'win32' && process.env.RS_WIN_SIGN === '1') signWindowsResources(context.appOutDir)
}

async function compileBytecode(context) {
  const isMac = context.electronPlatformName === 'darwin'
  const isWin = context.electronPlatformName === 'win32'
  const resources = isMac
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const py = path.join(resources, 'python', isWin ? 'python.exe' : 'bin/python3')
  if (!fs.existsSync(py)) {
    console.log(`[after-pack] no bundled python at ${py}; skipping bytecode compile`)
    return
  }
  if ((process.platform === 'win32') !== isWin || (process.platform === 'darwin') !== isMac) {
    throw new Error('afterPack must run on the target OS (the packed python has to be executable here)')
  }
  for (const dir of ['python', 'engine']) {
    const target = path.join(resources, dir)
    if (!fs.existsSync(target)) continue
    console.log(`[after-pack] compileall ${target}`)
    // -q quiet, -f force; single process on purpose: with -j0 Windows Defender/Search locks made parallel
    // workers fail renaming .pyc files ("Access is denied"). PYTHONDONTWRITEBYTECODE must be unset to write.
    const env = { ...process.env }
    delete env.PYTHONDONTWRITEBYTECODE
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          execFileSync(py, ['-s', '-m', 'compileall', '-q', '-f', target], { stdio: 'inherit', env })
          break
        } catch (e) {
          console.log(`[after-pack] compileall attempt ${attempt} reported errors for ${dir} (exit ${e.status})`)
          if (attempt >= 3) break   // a file that never compiles (e.g. newer-syntax test data) just stays source
        }
      }
    } catch (e) {
      // compileall exits 1 when some stdlib/test file has a syntax error for py3.11; not fatal
      console.log(`[after-pack] compileall reported errors for ${dir} (continuing): ${e.status}`)
    }
  }
}
