import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildPrompts, type PromptDef } from '../src/prompts.js'
import { buildTools } from '../src/tools/index.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'

const CREATOR_PROMPTS = ['create-image', 'create-video', 'create-audio', 'youtube-thumbnail', 'product-photoshoot', 'explainer-video']

const creatorPrompts = (): PromptDef[] =>
  buildPrompts({ enableNsfw: false }).filter((prompt) => CREATOR_PROMPTS.includes(prompt.name))

const render = (prompt: PromptDef, args: Record<string, string>): string =>
  prompt.build(args as never).messages.map((message) => message.content.text).join('\n')

function argumentsOf(prompt: PromptDef): { required: string[]; optional: string[] } {
  const entries = Object.entries(prompt.argsSchema as Record<string, z.ZodTypeAny>)
  return {
    required: entries.filter(([, schema]) => !schema.isOptional()).map(([name]) => name),
    optional: entries.filter(([, schema]) => schema.isOptional()).map(([name]) => name),
  }
}

const withEvery = (prompt: PromptDef) =>
  Object.fromEntries(Object.keys(prompt.argsSchema).map((name) => [name, `sample ${name}`]))

const withRequired = (prompt: PromptDef) =>
  Object.fromEntries(argumentsOf(prompt).required.map((name) => [name, `sample ${name}`]))

describe('creator workflow prompts', () => {
  it('are offered with and without NSFW prompts', () => {
    for (const enableNsfw of [true, false]) {
      const names = buildPrompts({ enableNsfw }).map((prompt) => prompt.name)
      assert.deepEqual(names.filter((name) => CREATOR_PROMPTS.includes(name)), CREATOR_PROMPTS)
    }
  })

  it('take only string arguments, as MCP prompt arguments are strings', () => {
    for (const prompt of creatorPrompts()) {
      for (const [name, schema] of Object.entries(prompt.argsSchema as Record<string, z.ZodTypeAny>)) {
        assert.equal(schema.safeParse('text').success, true, `${prompt.name}.${name}`)
        assert.equal(schema.safeParse(1).success, false, `${prompt.name}.${name}`)
      }
      assert.equal(argumentsOf(prompt).required.length, 1, prompt.name)
    }
  })

  it('name only tools this server registers', () => {
    const tools = new Set(buildTools(new StubClient().asClient(), loadConfig({ VENICE_API_KEY: 'k' })).map((tool) => tool.name))
    for (const prompt of creatorPrompts()) {
      for (const args of [withRequired(prompt), withEvery(prompt)]) {
        for (const name of render(prompt, args).match(/\bvenice_[a-z_]+/g) ?? []) {
          assert.ok(tools.has(name), `${prompt.name} names ${name}`)
        }
      }
    }
  })

  it('quote the price before queuing a paid job', () => {
    const order: Record<string, [string, string][]> = {
      'create-video': [['venice_video_quote', 'venice_video_generate']],
      'create-audio': [['venice_audio_quote', 'venice_music_generate']],
      'explainer-video': [['venice_video_quote', 'venice_video_generate'], ['venice_audio_quote', 'venice_music_generate']],
    }
    for (const prompt of creatorPrompts().filter((p) => p.name in order)) {
      const text = render(prompt, withRequired(prompt))
      for (const [quote, queue] of order[prompt.name]) {
        assert.ok(text.includes(quote), `${prompt.name} quotes with ${quote}`)
        assert.ok(text.indexOf(quote) < text.indexOf(queue), `${prompt.name} quotes before ${queue}`)
      }
      assert.match(text, /wait for a yes/, prompt.name)
    }
  })

  it('put every argument in the message and leave out the ones not given', () => {
    for (const prompt of creatorPrompts()) {
      const full = render(prompt, withEvery(prompt))
      for (const name of Object.keys(prompt.argsSchema)) assert.ok(full.includes(`sample ${name}`), `${prompt.name} uses ${name}`)
      assert.doesNotMatch(render(prompt, withRequired(prompt)), /undefined/, prompt.name)
    }
  })

  it('clean up a download_url result after downloading it', () => {
    const texts = Object.fromEntries(creatorPrompts().map((prompt) => [prompt.name, render(prompt, withRequired(prompt))]))
    assert.match(texts['create-video'], /If the result is a download_url, download it .* then call venice_video_complete with the same queue_id and model/)
    assert.match(texts['create-audio'], /If the result is a download_url, download it, then call venice_music_complete with the same queue_id and model/)
    assert.match(texts['explainer-video'], /calling venice_video_complete or venice_music_complete after downloading any download_url result/)
  })

  it('price narration from the speech model', () => {
    const texts = Object.fromEntries(creatorPrompts().map((prompt) => [prompt.name, render(prompt, withRequired(prompt))]))
    for (const name of ['create-audio', 'explainer-video']) {
      assert.match(texts[name], /pricing\.input\.usd in venice_model_details/, name)
    }
  })

  it('carry the consent rules for people and voices', () => {
    const texts = Object.fromEntries(creatorPrompts().map((prompt) => [prompt.name, render(prompt, withRequired(prompt))]))
    for (const name of ['create-image', 'create-video', 'youtube-thumbnail', 'explainer-video']) {
      assert.match(texts[name], /Only show a real person from their own photo or with their permission\./, name)
    }
    for (const name of ['create-video', 'explainer-video']) {
      assert.match(texts[name], /some video models reject footage of identifiable people, such as Seedance models whose id ends in -basic\. If one rejects a request showing a person, switch to another model family/, name)
    }
    assert.match(texts['create-audio'], /Clone a voice .* only if the person whose voice it is has agreed\./)
    assert.match(texts['explainer-video'], /A cloned voice needs its owner's permission too\./)
  })

  it('give the thumbnail the aspect ratio for a named format', () => {
    const thumbnail = creatorPrompts().find((prompt) => prompt.name === 'youtube-thumbnail')!
    for (const [format, ratio] of [['youtube', '16:9'], [' Shorts ', '9:16'], ['podcast', '1:1']]) {
      assert.match(render(thumbnail, { video: 'v', format }), new RegExp(`Format: a ${ratio} `), format)
    }
    assert.match(render(thumbnail, { video: 'v', format: 'square banner' }), /Format: square banner\./)
  })
})
