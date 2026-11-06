// The CLA check's decisions (.github/workflows/cla.yml). Plain functions, so app/test/cla-check.test.ts can test them.
//
// A pull request's author accepts CLA.md by commenting the exact sentence below on the pull request. The comment is
// the record: GitHub keeps it with its author and time. Maintainers listed as trusted in .github/VOUCHED.td own the
// project and need no agreement; bots don't sign.

const PHRASE = 'I have read the Contributor License Agreement in CLA.md and I agree to it.'
// Marks the check's own instructions comment, so a later run edits it instead of adding another.
const MARKER = '<!-- reel-studio-cla -->'

/** Logins listed as trusted in VOUCHED.td (`github:login`), lowercased. `-github:login` lines denounce, never trust. */
function trustedLogins(vouched) {
  const out = new Set()
  for (const raw of vouched.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('github:')) continue
    const login = line.slice('github:'.length).split(/\s+/)[0].toLowerCase()
    if (login) out.add(login)
  }
  return out
}

/** Case and runs of whitespace don't matter; anything else in the comment does. */
function isSignature(body) {
  const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return norm(body ?? '') === norm(PHRASE)
}

/**
 * The check's result for one pull request.
 * author: { login, type } of the PR's author (type 'Bot' for apps); comments: [{ login, body }] on the PR, any order.
 */
function claState({ author, comments, trusted }) {
  const login = String(author.login).toLowerCase()
  if (author.type === 'Bot') return { state: 'success', description: 'Bots do not sign the CLA.' }
  if (trusted.has(login)) return { state: 'success', description: 'Maintainer: no CLA needed.' }
  if (comments.some((c) => String(c.login).toLowerCase() === login && isSignature(c.body)))
    return { state: 'success', description: 'The author accepted the CLA.' }
  return { state: 'failure', description: 'The author has not accepted the CLA yet. See the comment on this pull request.' }
}

/** The instructions comment, addressed to the author. `repoUrl`: https://github.com/<owner>/<repo>. */
function instructions(login, repoUrl) {
  return [
    MARKER,
    `Thanks for the pull request, @${login}. Before it can merge, please read the [Contributor License Agreement](${repoUrl}/blob/HEAD/CLA.md) and, if you agree, comment this sentence on this pull request exactly:`,
    '',
    '```',
    PHRASE,
    '```',
    '',
    'The CLA check turns green once your comment is in.'
  ].join('\n')
}

module.exports = { PHRASE, MARKER, trustedLogins, isSignature, claState, instructions }
