import { expect, test } from 'claude-code/testing'
import type { CommandInfo, FsEntry, ModelCompleteResult, On, SessionMessage } from 'claude-code'

import { clean, describeRun, formatConversation, formatSkills, isSecret } from '../hooks/engine'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const answered = (text: string): ModelCompleteResult =>
  ({ isAnswered: true, text, usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as ModelCompleteResult

const file = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry =>
  ({ name, kind, size: 1, mtimeMs: 0, isLink: false }) as FsEntry

type Fake = {
  draft: string
  /** What the person types into the box while the enhancement runs. */
  editWhileEnhancing?: string
  reply?: ModelCompleteResult | Promise<ModelCompleteResult>
  /** The session's transcript so far; `'fails'` makes reading it throw. */
  messages?: SessionMessage[] | 'fails'
}

const msg = (role: SessionMessage['role'], text: string): SessionMessage => ({ role, text, toolUses: [] })

/** Stands in for the engine beneath the plugin and records what the plugin did. */
function fake(on: On, opts: Fake) {
  const seen = { fills: [] as string[], prompts: [] as string[], systems: [] as string[], reads: [] as string[], toasts: [] as string[] }
  const box = { text: opts.draft }
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    box.text = e.text
    return { isFilled: true }
  })
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    seen.systems.push(e.system ?? '')
    if (opts.editWhileEnhancing !== undefined) box.text = opts.editWhileEnhancing
    return Promise.resolve(opts.reply ?? answered('Enhanced prompt text.')).then(value => ({ value }))
  })
  on('command.list', () => ({
    value: [
      { name: 'frontend-design:frontend-design', description: 'Build polished web UIs', source: 'plugin' },
      { name: 'some-mcp-prompt', description: 'An MCP prompt', source: 'mcp' },
    ],
  }))
  on('session.root', () => ({ value: 'C:/proj' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('session.messages', () => {
    if (opts.messages === 'fails') throw new Error('no transcript')
    return { value: opts.messages ?? [] }
  })
  on('fs.list', () => ({
    value: [file('src', 'dir'), file('README.md'), file('package.json'), file('.env'), file('node_modules', 'dir')],
  }))
  on('fs.ancestors', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    return { value: e.path.endsWith('package.json') ? '{"dependencies":{"react":"19"}}' : '# My app' }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { seen, box }
}

test('the Enhance button is drawn on the desktop and terminal', async $ => {
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface, ...BAND })
    expect((await ui.find({ key: 'enhance' }))?.text).toContain('Enhance')
    expect((await ui.find({ key: 'enhance' }))?.props.variant).toBeUndefined()
    expect(await ui.find({ key: 'restore' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an empty draft is left alone and no model call is made', async ($, on) => {
  const { seen } = fake(on, { draft: '   ' })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })
  expect(seen.prompts).toHaveLength(0)
  expect(seen.fills).toHaveLength(0)
  expect(seen.toasts[0]).toContain('write a draft')
})

test('enhance replaces the draft, with project context and only real skills', async ($, on) => {
  const { seen } = fake(on, { draft: 'make the site look better' })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })

  expect(seen.fills).toEqual(['Enhanced prompt text.'])
  const prompt = seen.prompts[0] ?? ''
  expect(prompt).toContain('<draft>\nmake the site look better\n</draft>')
  expect(prompt).toContain('/frontend-design:frontend-design')
  expect(prompt).not.toContain('some-mcp-prompt')
  expect(prompt).toContain('"react":"19"')
  expect(seen.systems[0]).toContain('Never carry out the draft')
  // Secrets and noise are never read or listed.
  expect(seen.reads.some(p => p.includes('.env'))).toBe(false)
  expect(prompt).not.toContain('.env')
  expect(prompt).not.toContain('node_modules')
  expect(seen.toasts).toEqual([expect.stringMatching(/^enhanced · 1\.2k in \/ 150 out tokens · \d+\.\d s$/)])
})

test('the recent conversation is passed along, as data, to resolve references', async ($, on) => {
  const { seen } = fake(on, {
    draft: 'fix that bug',
    messages: [
      msg('user', 'Why does the login page crash?'),
      msg('assistant', 'The crash comes from a null session in auth.ts line 42.'),
      { role: 'assistant', text: '', toolUses: [] }, // a tool call alone: left out
      msg('user', '<system-reminder>engine note</system-reminder>'),
    ],
  })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })

  expect(seen.fills).toEqual(['Enhanced prompt text.'])
  const prompt = seen.prompts[0] ?? ''
  expect(prompt).toContain(
    '<recent_conversation>\nUser: Why does the login page crash?\n\nClaude: The crash comes from a null session in auth.ts line 42.\n</recent_conversation>',
  )
  expect(prompt).not.toContain('engine note')
  expect(seen.systems[0]).toContain('<recent_conversation>')
})

for (const [when, messages] of [['no conversation yet', []], ['an unreadable conversation', 'fails']] as const) {
  test(`with ${when}, enhancement still works`, async ($, on) => {
    const { seen } = fake(on, { draft: 'add dark mode', messages: messages === 'fails' ? 'fails' : [] })
    const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
    await ui.press({ key: 'enhance' })
    expect(seen.fills).toEqual(['Enhanced prompt text.'])
    expect(seen.prompts[0]).toContain('(none: this is the start of the session)')
    expect(seen.toasts).toEqual([expect.stringMatching(/^enhanced · 1\.2k in \/ 150 out tokens · \d+\.\d s$/)])
  })
}

test('restore puts the original draft back', async ($, on) => {
  const { seen } = fake(on, { draft: 'fix login' })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })
  expect(await ui.find({ key: 'restore' })).toBeDefined()
  await ui.press({ key: 'restore' })
  expect(seen.fills).toEqual(['Enhanced prompt text.', 'fix login'])
  expect(await ui.find({ key: 'restore' })).toBeUndefined()
})

test('restore refuses to overwrite edits made to the enhanced prompt', async ($, on) => {
  const { seen, box } = fake(on, { draft: 'fix login' })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })
  box.text = 'Enhanced prompt text. Also add tests.' // the person edits it
  await ui.press({ key: 'restore' })
  expect(seen.fills).toEqual(['Enhanced prompt text.'])
  expect(seen.toasts.at(-1)).toContain('edited')
})

test('a failed model call keeps the draft and says why', async ($, on) => {
  const failed = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelCompleteResult
  const { seen } = fake(on, { draft: 'add a database', reply: failed })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })
  expect(seen.fills).toHaveLength(0)
  expect(seen.toasts[0]).toContain('HTTP 529')
  expect(seen.toasts[0]).toContain('unchanged')
})

test('edits made while enhancing are kept, not overwritten', async ($, on) => {
  const { seen } = fake(on, { draft: 'first draft', editWhileEnhancing: 'first draft, edited' })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  await ui.press({ key: 'enhance' })
  expect(seen.fills).toHaveLength(0)
  expect(seen.toasts[0]).toContain('edits were kept')
})

test('a second press while enhancing makes no second request', async ($, on) => {
  let release: (r: ModelCompleteResult) => void = () => {}
  const pending = new Promise<ModelCompleteResult>(resolve => (release = resolve))
  const { seen } = fake(on, { draft: 'refactor auth', reply: pending })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND })
  const first = ui.press({ key: 'enhance' })
  const second = ui.press({ key: 'enhance' })
  expect((await ui.find({ key: 'enhance' }))?.text).toMatch(/^. Enhancing…$/)
  release(answered('Better auth prompt.'))
  await Promise.all([first, second])
  expect(seen.prompts).toHaveLength(1)
  expect(seen.fills).toEqual(['Better auth prompt.'])
})

test('the band yields to a survey', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="survey">survey</Text>
  })
  const ui = await $.ui.mount({ plugin: 'prompt-enhancer', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'enhance' })).toBeUndefined()
})

test('clean strips wrapping and labels', () => {
  expect(clean('```\nDo the thing.\n```')).toBe('Do the thing.')
  expect(clean('Enhanced prompt: Do the thing.')).toBe('Do the thing.')
  expect(clean('  Keep `code` inside.  ')).toBe('Keep `code` inside.')
})

test('only the last few messages are kept, each clipped', () => {
  const many = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message ${i}`))
  const text = formatConversation(many)
  expect(text).not.toContain('message 11')
  expect(text.startsWith('User: message 12')).toBe(true)
  expect(text.endsWith('Claude: message 19')).toBe(true)
  expect(formatConversation([msg('user', 'x'.repeat(5000))]).length).toBeLessThan(1600)
})

test('secret-looking names are recognised', () => {
  for (const name of ['.env', '.env.local', 'secrets.json', 'id_rsa', 'server.pem', 'credentials.yml']) {
    expect(isSecret(name)).toBe(true)
  }
  for (const name of ['src', 'README.md', 'package.json', 'environment.ts']) {
    expect(isSecret(name)).toBe(false)
  }
})

test('describeRun reports total input, output and seconds', () => {
  const usage = { input_tokens: 300, output_tokens: 1250, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }
  expect(describeRun(usage, 3420)).toBe('enhanced · 1.5k in / 1.3k out tokens · 3.4 s')
  expect(describeRun({ ...usage, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 90 }, 800))
    .toBe('enhanced · 0 in / 90 out tokens · 0.8 s')
})

test('skills: the best matches keep a description, every other one stays listed by name', () => {
  const commands: CommandInfo[] = [
    { name: 'anthropic-skills:pptx', description: 'Create and edit PowerPoint presentation decks', source: 'plugin' },
    { name: 'blender-skills:lighting', description: 'Studio lighting for Blender scenes', source: 'plugin' },
    { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
    { name: 'some-mcp-prompt', description: 'A presentation prompt from an MCP server', source: 'mcp' },
  ]
  const listed = formatSkills(commands, 'Create a presentation for my project')
  expect(listed).toContain('Most relevant:\n/anthropic-skills:pptx — Create and edit PowerPoint presentation decks')
  expect(listed).toContain('Also installed (names only):\n/blender-skills:lighting, /clear')
  expect(listed).not.toContain('Studio lighting')
  expect(listed).not.toContain('some-mcp-prompt')
})

test('skills: words from the recent conversation count too, and with no match all are names only', () => {
  const commands: CommandInfo[] = [
    { name: 'roblox-dev:roblox-ui', description: 'Roblox UI and visual effects patterns', source: 'plugin' },
    { name: 'godot', description: 'Develop Godot 4.x games', source: 'plugin' },
  ]
  expect(formatSkills(commands, 'add a settings menu', 'We are building a Roblox game')).toContain(
    'Most relevant:\n/roblox-dev:roblox-ui — Roblox UI and visual effects patterns',
  )
  expect(formatSkills(commands, 'hello there')).toBe('Also installed (names only):\n/roblox-dev:roblox-ui, /godot')
})
