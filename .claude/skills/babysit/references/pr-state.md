# Check a PR's current review state

Use these read-only queries when `babysit` needs readiness evidence. Replace placeholders with the exact target repository and PR. `gh pr view` supports `comments` and `reviews`, but neither exposes inline thread resolution.

## Inline threads

```sh
gh api graphql --paginate \
  -F owner='<owner>' -F name='<repo>' -F number=<number> \
  -f query='
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id isResolved isOutdated
          comments(first: 1) { nodes { url body author { login } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'
```

The first comment identifies each thread; it is not the full discussion. Before acting on a thread, retrieve its replies with `gh api --paginate repos/<owner>/<repo>/pulls/<number>/comments` or inspect the thread URL. An outdated thread is not necessarily resolved. API errors, inaccessible pages or incomplete pagination leave readiness unverified.

## Checks and review completion

```sh
gh pr checks <number> -R <owner/repo> --json name,state,bucket,link
gh pr checks <number> -R <owner/repo> --required --json name,state,bucket,link
```

Read both results. Buckets are `pass`, `fail`, `pending`, `skipping` and `cancel`. Exit code 8 means pending. A nonzero exit or empty result is not a green build. If no checks are configured, verify that against the repository's workflows and applicable branch rulesets and say so. Do not invent required checks or treat a missing expected check as optional.

A bot may publish a check run, a review or a comment. Inspect the existing bot's actual completion signal and its commit association. A prior-head approval, an acknowledgement reaction or a quiet comment stream does not prove the current head was reviewed. If there is no configured bot, report that fact rather than installing one. Human approvals required by repository rules remain separate.

Record `headRefOid` before inspection and fetch it again afterward. Reassess after any head change. Fetch checks and threads again after each fix push. Report the SHA and observation time with readiness; it is a snapshot, not a promise that later pushes stay ready.

Sources: [gh api pagination](https://cli.github.com/manual/gh_api), [gh pr checks](https://cli.github.com/manual/gh_pr_checks), [gh pr view](https://cli.github.com/manual/gh_pr_view). Verified field support against local gh help on 2026-09-05.
