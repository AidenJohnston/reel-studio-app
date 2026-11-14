// The whole "Remember this for next time?" handoff for a rule the person paused in My style and asks for again in a
// note: the real AI package runs the note, the app's own consent step asks, and the person answers.
import { describe, expect, it } from 'vitest'
import { createAI, StyleStore } from '../../ai/src'
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from '../../ai/test/helpers'
import type { ChatMessage } from '../src/shared/api'
import { askAboutStyle, answerStyleQuestion } from '../src/main/style-consent'
import { serialized } from '../src/main/store'

const RULE = 'Keep music quieter under talking.'

async function askedAgain() {
  const { root, dir } = await makeProject()
  const style = new StyleStore(() => root)
  const { rule } = await style.add(RULE)
  await style.update(rule.id, { paused: true })
  const ai = createAI({
    host: new FakeHost(root), settingsDir: tmpDir('settings '),
    providerOverride: new ScriptedModel([{ toolCalls: [call('add_style_rule', { rule: RULE })] }, { toolCalls: [call('finish', { summary_for_user: 'I can keep it quieter.' })] }])
  })
  // the app runs every note with its own consent step (main/index.ts startNote): nothing saved by the note itself
  const r = await ai.applyNote(dir, 'always keep the music quieter under talking', () => undefined, undefined, { id: 'job-1', saveStyleRules: false })
  const asked = await askAboutStyle(ai, r, r.summary)
  const chat: ChatMessage[] = asked.chat.map((m, i) => ({ ...m, id: `m${i}`, at: new Date().toISOString() }))
  const answer = (yes: boolean) =>
    answerStyleQuestion({
      chat: async () => chat, title: async () => 'Bread', answer: ai.answerStyleQuestion.bind(ai), serialized,
      settle: async (_s, id, reply) => { const q = chat.find((m) => m.id === id)!; delete q.actions; chat.push({ id: 'reply', from: 'editor', text: reply, at: q.at }) }
    }, 'bread', chat.find((m) => m.suggestion)!.id, yes)
  return { style, rule, asked, answer, chat }
}

describe('asking again in a note for a rule paused in My style', () => {
  it('fails if the rule leaves My style before the person answers, or No does not leave it paused', async () => {
    const { style, rule, asked, answer } = await askedAgain()
    expect(asked.chat.filter((m) => m.suggestion).map((m) => m.text)).toEqual([`Remember this for next time? "${RULE}"`])
    expect(await style.list()).toEqual([expect.objectContaining({ id: rule.id, paused: true })])
    await answer(false)
    expect(await style.list()).toEqual([expect.objectContaining({ id: rule.id, text: RULE, paused: true })])
  })

  // a Yes never turns a paused rule back on, only My style does (StyleStore.answer): no order of answers can change it
  it('fails if Yes adds a copy, or turns the paused rule back on behind My style', async () => {
    const { style, rule, answer, chat } = await askedAgain()
    await answer(true)
    const rules = await style.list()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ id: rule.id, text: RULE, paused: true })
    expect(chat.at(-1)?.text).toBe('That is in My style, but paused. Turn it back on in My style to use it in your next reels.')
  })
})
