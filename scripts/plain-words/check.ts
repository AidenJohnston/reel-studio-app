// The plain-words check: `node scripts/plain-words/check.ts` from the repo root (Node 24 runs TypeScript as is).
// Fails when a technical word is on the path to a first reel, or when scope.ts names a file that is gone.
// --all also lists the hits in files off the path; --json prints the whole report.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from './scan.ts'
import { scope } from './scope.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const report = scan(repo, scope)
const args = process.argv.slice(2)

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const say = (title: string, hits: typeof report.failing) => {
    console.log(`${title}: ${hits.length}`)
    for (const h of hits) {
      const instead = scope.words.find((w) => w.name === h.word)?.instead ?? 'a comma, a colon or two sentences'
      console.log(`  ${h.file}:${h.line}  "${h.word}" (say: ${instead})  in: ${JSON.stringify(h.text.slice(0, 160))}`)
    }
  }
  say('On the path to a first reel', report.failing)
  if (args.includes('--all')) say('Off the path (reported, not failed)', report.offPath)
  if (report.missing.length) {
    console.log(`Scope entries that match nothing (fix scripts/plain-words/scope.ts): ${report.missing.length}`)
    for (const m of report.missing) console.log(`  ${m}`)
  }
  console.log(`Read ${report.strings} strings in ${report.files} files.`)
}
process.exitCode = report.failing.length || report.missing.length ? 1 : 0
