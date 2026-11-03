import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Long-term memory: facts the user asked STRING to keep across sessions.
 *
 * Without it every reload is a stranger — "I'm in Bengaluru", "my standup is
 * at ten" have to be said again each time. The store is one small JSON file in
 * the home directory, outside the repo, so nothing personal can be committed.
 * Saved facts are read into the system prompt when a session starts (see
 * memoryPrompt), so they cost no tool call to use.
 */

const FILE = process.env.STRING_MEMORY_FILE || join(homedir(), '.string', 'memory.json')
const MAX = 200

/** @returns {{ id: string, fact: string, at: string }[]} */
function load() {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function save(items) {
  mkdirSync(dirname(FILE), { recursive: true })
  // Write-then-rename, so a crash mid-write never leaves half a file.
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(items.slice(-MAX), null, 1))
  renameSync(tmp, FILE)
}

/** The block appended to the system prompt; empty when nothing is saved. */
export function memoryPrompt() {
  const items = load()
  if (!items.length) return ''
  return (
    '\n\nWHAT YOU KNOW ABOUT THE USER (saved with `remember`; use it, do not recite it):\n' +
    items.map((m) => `- ${m.fact}`).join('\n')
  )
}

export const memoryCount = () => load().length

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    tools: [
      tool(
        'remember',
        'Save a fact about the user for future sessions: a preference, where they live, ' +
          'a routine, a name. Use when they say "remember…", or state something lasting ' +
          'about themselves. One short sentence per fact, in the third person ("Lives in Bengaluru").',
        { fact: z.string().describe('The fact, one short sentence.') },
        async ({ fact }) => {
          const text = String(fact ?? '').trim()
          if (!text) return { isError: true, content: [{ type: 'text', text: 'Nothing to remember.' }] }
          const items = load()
          if (items.some((m) => m.fact.toLowerCase() === text.toLowerCase())) {
            return { content: [{ type: 'text', text: 'Already known.' }] }
          }
          const id = `m${Date.now().toString(36)}`
          items.push({ id, fact: text, at: new Date().toISOString() })
          save(items)
          return { content: [{ type: 'text', text: `Saved (${id}).` }] }
        },
      ),
      tool(
        'recall',
        'List everything saved about the user, with ids. Use when they ask what you remember.',
        {},
        async () => {
          const items = load()
          const text = items.length ? items.map((m) => `${m.id}: ${m.fact}`).join('\n') : 'Nothing saved yet.'
          return { content: [{ type: 'text', text }] }
        },
      ),
      tool(
        'forget',
        'Delete saved facts. Pass the id from `recall`, or "all" when the user asks to forget everything.',
        { id: z.string() },
        async ({ id }) => {
          const items = load()
          const keep = id === 'all' ? [] : items.filter((m) => m.id !== id)
          if (keep.length === items.length) {
            return { isError: true, content: [{ type: 'text', text: `No saved fact with id ${id}.` }] }
          }
          save(keep)
          return { content: [{ type: 'text', text: `Forgot ${items.length - keep.length}.` }] }
        },
      ),
    ],
  })
}
