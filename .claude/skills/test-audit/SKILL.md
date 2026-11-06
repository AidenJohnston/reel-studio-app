---
name: test-audit
description: "Use when writing, changing, reviewing or cleaning up tests. Admits only tests that would catch a real regression, and removes low-signal ones with evidence."
---

# Test audit

A test earns its run time, flake risk and refactor cost only by catching a regression someone would notice. Ask of every test: **has this ever failed, or would it ever fail, in a way that meant something real broke?** If not, don't write it, or delete it.

## Writing a test

Stop at the first failed step:

1. Name the regression as "fails if ___". The blank is something a user, caller or persisted file can observe.
2. The regression is credible: it has happened, nearly happened, or is one plausible edit away.
3. No existing test already catches it. Each behavior gets one owner test, at the strongest boundary where a user meets it. Extend that test instead of replaying the bug at every layer it crosses.
4. It fails on the unfixed code for the reason you named. If you can't run the old code, say so.

Drive it through the real interface with real inputs. Never add an export, flag or hook to production code just so a test can reach it.

## Delete, or never write

- Facts the type system already guarantees.
- Mirrors of the code: an expected value computed by the code under test, a restated constant or prompt, a copied export or file list, a source grep.
- Implementation pins: internal call order or shape, mock-call counts on internal collaborators. A behavior-preserving refactor must not break a test.
- A mock that supplies the behavior being asserted, or fakes an ordering or receipt the real code is supposed to produce.
- Trivial UI or DOM behavior, or exact pixels.
- Real or fake timers standing in for logic, and wall-clock performance thresholds.
- Duplicate table rows that exercise the same branch.
- Smoke tests with no assertion on the result.
- A name that promises behavior the inputs never reach.

## Keep, even when slow or static

Orchestration and event ordering; persistence, formats and migrations; crash, cancel and recovery; protocol and external-format translation; auth, permission and path-safety guards; deterministic race reproductions; user-facing defaults; packaging and release contracts.

Test layout only where a user would notice the break and it's easy to cause, such as a preview losing its aspect ratio, a primary control falling off-screen, or overflow at supported window sizes and scaling. Never test margins.

A test failing on main may be a real bug. Reproduce it before deleting anything.

## Auditing a suite

- Before you cut a test, read it, the code it covers and that code's callers, and why the test was added (`git log -S`). Record what would still catch its regression. With no answer, keep it.
- When a test was the only caller of an export, wrapper or flag, delete that seam too.
- Clean one subsystem at a time. Never optimize for deletion count.
- Afterward, run that area's remaining tests, the typecheck and the unused-export check. Report time saved, what was kept and why, and what was removed by category.

## In a PR

List each new test as one line, "fails if ___", seen failing without the fix.
