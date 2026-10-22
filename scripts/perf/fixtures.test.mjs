import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteFixture } from './fixtures.mjs'

test('repeated tool names have distinct provider call identities', () => {
  const calls = noteFixture().steps.flatMap((step) => step.response.toolCalls)
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length)
  assert.equal(calls.filter((call) => call.name === 'set_caption_style').length, 2)
})
