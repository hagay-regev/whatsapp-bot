import fs from 'fs'
import path from 'path'

const MEMORY_PATH = path.join(__dirname, '..', 'memory.json')

export interface Memory {
  rules: string[]
  facts: string[]
  people: Record<string, string>
}

function load(): Memory {
  if (!fs.existsSync(MEMORY_PATH)) return { rules: [], facts: [], people: {} }
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8')) }
  catch { return { rules: [], facts: [], people: {} } }
}

function save(mem: Memory): void {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf-8')
}

export function getMemory(): Memory { return load() }

export function saveRule(rule: string): void {
  const mem = load()
  if (!mem.rules.includes(rule)) { mem.rules.push(rule); save(mem) }
}

export function saveFact(fact: string): void {
  const mem = load()
  if (!mem.facts.includes(fact)) { mem.facts.push(fact); save(mem) }
}

export function savePerson(name: string, info: string): void {
  const mem = load(); mem.people[name] = info; save(mem)
}

export function deleteFact(fact: string): void {
  const mem = load(); mem.facts = mem.facts.filter(f => f !== fact); save(mem)
}

export function deleteRule(rule: string): void {
  const mem = load(); mem.rules = mem.rules.filter(r => r !== rule); save(mem)
}

export function buildMemoryPrompt(): string {
  const mem = load()
  const parts: string[] = []
  if (mem.rules.length > 0) parts.push('## כללי התנהגות\n' + mem.rules.map(r => `- ${r}`).join('\n'))
  if (mem.facts.length > 0) parts.push('## עובדות שנשמרו\n' + mem.facts.map(f => `- ${f}`).join('\n'))
  if (Object.keys(mem.people).length > 0) {
    const lines = Object.entries(mem.people).map(([n, i]) => `- ${n}: ${i}`).join('\n')
    parts.push('## אנשים שאני מכיר\n' + lines)
  }
  return parts.length > 0 ? parts.join('\n\n') : '(אין זיכרון עדיין)'
}
