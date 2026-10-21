const { execFileSync } = require('node:child_process')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')

function processTable(pid) {
  const args = pid === undefined ? ['-axo', 'pid=,ppid=,lstart=,stat=,command=']
    : ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,stat=,command=']
  let output
  try { output = execFileSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }) }
  catch (error) { if (pid !== undefined && error.status === 1 && !error.stdout?.trim()) return []; throw error }
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.*)$/)
    if (!match) throw new Error(`Cannot parse process identity: ${line}`)
    return { pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3].replace(/\s+/g, ' '), status: match[4], command: match[5] }
  }).filter((row) => !row.status.startsWith('Z'))
}

function readRegistry(registry) {
  const rows = existsSync(registry) ? readFileSync(registry, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  if (rows.some(({ pid, startedAt }) => !Number.isInteger(pid) || pid <= 1 || typeof startedAt !== 'string' || !startedAt)) throw new Error('Invalid process identity registry')
  return rows
}

function registerProcess(registry, pid) {
  const [row] = processTable(pid)
  if (!row) return
  appendFileSync(registry, JSON.stringify(row) + '\n')
  return row
}

function captureDescendants(registry) {
  const registered = readRegistry(registry)
  const rows = processTable()
  const owned = new Map(registered.map((row) => [`${row.pid}:${row.startedAt}`, row]))
  const live = new Map(rows.map((row) => [row.pid, row]))
  let added
  do {
    added = false
    for (const row of rows) {
      if (owned.has(`${row.pid}:${row.startedAt}`)) continue
      const parent = live.get(row.ppid)
      if (!parent || !owned.has(`${parent.pid}:${parent.startedAt}`)) continue
      owned.set(`${row.pid}:${row.startedAt}`, row)
      appendFileSync(registry, JSON.stringify(row) + '\n')
      added = true
    }
  } while (added)
  return rows.filter((row) => owned.has(`${row.pid}:${row.startedAt}`))
}

module.exports = { processTable, readRegistry, registerProcess, captureDescendants }
