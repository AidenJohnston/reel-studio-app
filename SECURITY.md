# Security policy

## Reporting a vulnerability

Please report security problems privately, never in a public issue, pull request or discussion. Either way works:

- **On GitHub:** this repository's **Security** tab, **Report a vulnerability**. The report stays private, and we can
  work on a fix with you there.
- **By e-mail:** support@getreelstudio.com, with "Security" in the subject.

Include what you found and its security impact, how to reproduce it, the Reel Studio version and your operating
system. Leave out anything private, such as your own videos or API keys.

We aim to reply within 3 working days. Please give us a chance to ship a fix before you disclose it publicly; we will
agree a date with you and ask how you would like to be credited.

## What counts

- The desktop app, its bundled engine and AI editor, including how it stores and sends an API key you paste in.
- The update and download service it talks to (`dl.getreelstudio.com`).
- This repository's workflows.

Problems inside Claude Code, Codex or other tools Reel Studio drives belong with their vendors. Reel Studio never sees
your sign-in to those tools.

## Supported versions

Security fixes ship in a new release. The current version is the one the app's update check offers
(`dl.getreelstudio.com`); older versions don't get backported fixes.
