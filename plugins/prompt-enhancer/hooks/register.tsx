import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Undo } from '../types'
import type { Enhanced } from './engine'
import { MODEL, SYSTEM, buildPrompt, describeRun, filesToRead, formatContext, formatConversation, formatSkills, listable, toEnhanced } from './engine'

const busy = atom({ plugin: 'prompt-enhancer', key: 'busy' } as const, false)
const undo = atom({ plugin: 'prompt-enhancer', key: 'undo' } as const, null as Undo | null)
const frame = atom({ plugin: 'prompt-enhancer', key: 'frame' } as const, 0)

/** Claude Code's own working star, pulsing while an enhancement runs. */
const STARS = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
const STAR_MS = 150

function say($: EngineInterface, text: string) {
  $.ui.toast(text) // the Desktop app already names the mod beside its messages
}

/** The names among `names` that git ignores in `root`; none when it is not a repository. */
async function ignoredNames($: EngineInterface, root: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const result = await $.process
    .run(['git', 'check-ignore', '--', ...names], { cwd: root, timeoutMs: 5000 })
    .catch(() => undefined)
  return new Set(result?.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [])
}

/**
 * A short, relevant picture of the project the session runs in: its top-level
 * layout, CLAUDE.md / AGENTS.md, README and manifests. Empty for an empty folder.
 */
async function projectContext($: EngineInterface): Promise<string> {
  const root = (await $.session.root()).replace(/[\\/]$/, '')
  const candidates = listable(await $.fs.list(root).catch(() => []))
  const ignored = await ignoredNames($, root, candidates.map(e => e.name))
  const visible = candidates.filter(e => !ignored.has(e.name))

  const instructions = await $.fs.ancestors({ names: ['CLAUDE.md', 'AGENTS.md'] }).catch(() => [])
  const read = await Promise.all(
    filesToRead(new Set(visible.map(e => e.name))).map(([name, max]) =>
      $.fs.read(`${root}/${name}`).then(
        text => [name, String(text), max] as [string, string, number],
        () => undefined,
      )),
  )
  return formatContext(visible, instructions, read.filter(f => f !== undefined))
}

/** Rewrites `draft` with one tool-less model call; the draft is never run. */
async function enhance($: EngineInterface, draft: string): Promise<Enhanced> {
  const [context, commands, messages] = await Promise.all([
    projectContext($),
    $.command.list().catch(() => []),
    $.session.messages().catch(() => []),
  ])
  const conversation = formatConversation(messages)
  const prompt = buildPrompt(context, formatSkills(commands, draft, conversation), draft, conversation)
  return toEnhanced(await $.model.complete({ model: MODEL, system: SYSTEM, prompt, maxTokens: 2000, timeoutMs: 90_000 }))
}

// Guards against a second press while one runs; the `busy` atom only redraws the label.
let isRunning = false

async function enhanceDraft($: EngineInterface) {
  if (isRunning) return
  isRunning = true // before any await, so a second press can't slip past
  const pulse = $.clock.every(STAR_MS, () => {
    update($, frame, f => f + 1).catch(() => {})
  })
  try {
    const { text: draft } = await $.prompt.read()
    if (draft.trim() === '') {
      say($, 'write a draft in the prompt box first.')
      return
    }
    await update($, busy, () => true)
    const startedAt = await $.clock.now().catch(() => undefined) // stats are best-effort
    const result = await enhance($, draft)
    if (!result.isEnhanced) {
      say($, `couldn't enhance (${result.error}). Your draft is unchanged.`)
      return
    }
    if ((await $.prompt.read()).text !== draft) {
      say($, 'you edited the draft while it was enhancing, so your edits were kept.')
      return
    }
    const filled = await $.prompt.fill({ text: result.text, mode: 'replace' })
    if (!filled.isFilled) {
      say($, "couldn't update the prompt box. Your draft is unchanged.")
      return
    }
    await update($, undo, () => ({ original: draft, enhanced: filled.text }))
    const endedAt = await $.clock.now().catch(() => undefined)
    if (startedAt !== undefined && endedAt !== undefined) say($, describeRun(result.usage, endedAt - startedAt))
  } catch (err) {
    say($, `something went wrong (${err instanceof Error ? err.message : String(err)}). Your draft is unchanged.`)
  } finally {
    pulse.cancel()
    isRunning = false
    await update($, busy, () => false)
  }
}

async function restore($: EngineInterface) {
  const last = await read($, undo)
  if (last === null) return
  const { text } = await $.prompt.read()
  if (text !== last.enhanced && text.trim() !== '') {
    say($, "you've edited the enhanced prompt, so it wasn't replaced. Clear the box first to restore.")
    return
  }
  const filled = await $.prompt.fill({ text: last.original, mode: 'replace' })
  if (filled.isFilled) await update($, undo, () => null)
}

export const register: Register = on => {
  // A sent prompt ends the chance to restore the draft it replaced. Never awaited:
  // nothing here may delay or block Send.
  on('prompt.submit', ($, e, next) => {
    update($, undo, () => null).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const isBusy = await read($, busy)
    const canRestore = (await read($, undo)) !== null
    const star = STARS[(await read($, frame)) % STARS.length]

    // Right-aligned, so Enhance sits above the model selector. The desktop draws
    // its own native button (label colours are ignored); the default look is kept.
    return (
      <Box flexDirection="row" justifyContent="flex-end" gap={1}>
        {canRestore && !isBusy ? (
          <Button key="restore" dimColor label="↩ Restore original" onPress={() => restore($)} />
        ) : null}
        <Button key="enhance" label={isBusy ? `${star} Enhancing…` : '✻ Enhance'} onPress={() => enhanceDraft($)} />
      </Box>
    )
  })
}
