/**
 * Repository for `backend.env` — the dotenv-style file the Python backend
 * reads at startup for API keys and provider config.
 *
 * Why a separate aggregate from `SettingsRepository`:
 *   `apia-settings.json` is JSON validated by zod and owns user-visible
 *   preferences. `backend.env` is line-oriented KEY=value, must round-trip
 *   with `backend/ai_config.py`'s loader (which preserves comments + blank
 *   lines), and holds secrets. Two different invariants, two different
 *   persistence formats — collapsing them into one aggregate would mean a
 *   single class with two boundary contracts. Per Codex review.
 *
 * Security model:
 *   - `applyUpdates` only writes keys on `ALLOWED_KEYS`. Renderer-supplied
 *     keys outside the list are dropped silently. A compromised renderer
 *     therefore can't seed arbitrary env vars into the next backend launch.
 *   - `presence()` returns `{ KEY: { present: boolean } }` — never the
 *     actual value. The renderer is structurally incapable of reading the
 *     stored secret back, even via devtools snooping on the IPC payload.
 *   - Writes go through a tmp-file rename so a crash mid-write doesn't
 *     leave the user with a half-written backend.env.
 *
 * Comment / blank-line preservation:
 *   `ai_config.py`'s loader handles comments, blanks, `export ` prefix and
 *   quoted values. Our writer treats every non-KEY=value line as opaque
 *   text and rewrites those lines verbatim. Updates rewrite the value on
 *   the existing line if the key is present, or append at end-of-file.
 *   Clear (`*_clear: true`) removes the line entirely so the backend's
 *   default kicks in.
 */
const fs = require('fs')
const path = require('path')

const ALLOWED_KEYS = Object.freeze(['APIA_GROQ_KEY', 'APIA_ANTHROPIC_KEY', 'APIA_HF_TOKEN'])
const ALLOWED_KEY_SET = new Set(ALLOWED_KEYS)
const ENV_FILENAME = 'backend.env'

/**
 * Parse a single line into one of three shapes:
 *   { kind: 'kv', name, value, raw }  — recognized KEY=VALUE (allowlist-agnostic)
 *   { kind: 'other', raw }            — comment, blank line, malformed, etc.
 * The parser tolerates `export KEY=VALUE` and quoted values to match
 * `ai_config.py`'s loader so a round-trip on an existing file doesn't change
 * its semantics.
 */
function parseLine(rawLine) {
  const line = rawLine.replace(/^﻿/, '')
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return { kind: 'other', raw: rawLine }
  }

  let body = trimmed
  if (body.startsWith('export ')) {
    body = body.slice(7).trim()
  }
  const eq = body.indexOf('=')
  if (eq <= 0) {
    return { kind: 'other', raw: rawLine }
  }

  const name = body.slice(0, eq).trim()
  let value = body.slice(eq + 1).trim()
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1)
  }

  return { kind: 'kv', name, value, raw: rawLine }
}

/**
 * Quote a value if it would otherwise be ambiguous to the dotenv-style
 * loader (whitespace at the edges, quote inside, leading `#`). API keys
 * are normally safe ASCII, so this is rarely triggered, but it keeps the
 * writer correct for the long tail.
 */
function quoteValueIfNeeded(value) {
  if (value === '') return ''
  const needsQuoting = /[\s"'#=]/.test(value) || value.trim() !== value
  if (!needsQuoting) return value
  const escaped = value.replace(/"/g, '\\"')
  return `"${escaped}"`
}

class BackendEnvRepository {
  #dataDir
  #log

  /**
   * `log.warn` is required because all IO failures here are tolerated —
   * the backend simply won't pick up the new key, and the renderer gets an
   * `{ok: false, error}` IPC response. The warn line gives ops a trace.
   */
  constructor({ dataDir, log }) {
    if (!dataDir) throw new Error('BackendEnvRepository: dataDir required')
    if (!log?.warn) throw new Error('BackendEnvRepository: log.warn required')
    this.#dataDir = dataDir
    this.#log = log
  }

  getEnvPath() {
    return path.join(this.#dataDir, ENV_FILENAME)
  }

  /**
   * Read and parse the file. Returns `{ lines, byName }` where `lines` is
   * the preserved line-by-line array and `byName` is a lookup of the last
   * occurrence of each KEY=VALUE pair. Missing file is treated as an empty
   * document — callers don't need to special-case bootstrap.
   */
  readDocument() {
    const envPath = this.getEnvPath()
    if (!fs.existsSync(envPath)) {
      return { lines: [], byName: new Map() }
    }

    const text = fs.readFileSync(envPath, 'utf-8')
    // Don't use {lossy:true} split — we need to preserve original line
    // endings in lines we don't touch. Split that captures the separator
    // is overkill; rewriting always uses '\n' on disk regardless of OS so
    // PowerShell, the Python loader, and git diffs all see consistent
    // content. Pre-existing CRLF inside an untouched line is preserved
    // because we round-trip the raw line.
    const rawLines = text.split(/\n/)
    // A trailing '\n' produces a final empty element — drop it so a
    // round-trip read/write doesn't grow blank lines.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop()
    }

    const lines = rawLines.map((raw) => parseLine(raw))
    const byName = new Map()
    for (const line of lines) {
      if (line.kind === 'kv') {
        byName.set(line.name, line.value)
      }
    }
    return { lines, byName }
  }

  /**
   * Renderer-facing presence map. Only the allowlist is reported so adding
   * new providers requires a deliberate code change — the renderer can't
   * discover keys outside the contract.
   */
  presence() {
    const { byName } = this.readDocument()
    const out = {}
    for (const key of ALLOWED_KEYS) {
      const value = byName.get(key)
      out[key] = { present: typeof value === 'string' && value.length > 0 }
    }
    return out
  }

  /**
   * Apply an updates payload. Shape:
   *   { APIA_GROQ_KEY?: string, APIA_GROQ_KEY_clear?: boolean, ... }
   *
   * Rules:
   *   - `_clear: true` removes the matching KEY=VALUE line. The backend
   *     falls back to its default.
   *   - A non-empty string replaces or appends. An empty string is
   *     ignored (use `_clear` to remove) so the UX "I left the box blank
   *     because I don't want to change it" is preserved.
   *   - Anything outside `ALLOWED_KEYS` is silently ignored.
   *
   * Returns `{ written: string[], cleared: string[] }` listing the keys
   * that actually changed, so the renderer can show a precise toast.
   */
  applyUpdates(updates) {
    if (!updates || typeof updates !== 'object') {
      return { written: [], cleared: [] }
    }

    const { lines } = this.readDocument()
    const written = []
    const cleared = []

    for (const key of ALLOWED_KEYS) {
      const clearFlag = Boolean(updates[`${key}_clear`])
      const raw = updates[key]
      const value = typeof raw === 'string' ? raw : null

      // Duplicate KEY=... lines are legal in dotenv (the loader takes the
      // last one), but they make in-place edits ambiguous. Collect every
      // matching index up front so clear and update both target the full
      // set, not just the first.
      const matches = []
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (line.kind === 'kv' && line.name === key) matches.push(i)
      }

      if (clearFlag) {
        // Remove every duplicate so the backend default is unambiguous
        // (otherwise the loader's "last value wins" rule would still
        // expose a stale earlier value if we only dropped the last one).
        // Splice from the tail so indices stay valid.
        if (matches.length > 0) {
          for (let i = matches.length - 1; i >= 0; i -= 1) {
            lines.splice(matches[i], 1)
          }
          cleared.push(key)
        }
        continue
      }

      if (value === null || value === '') {
        continue // "no change"
      }

      const formatted = `${key}=${quoteValueIfNeeded(value)}`
      if (matches.length === 0) {
        lines.push({ kind: 'kv', name: key, value, raw: formatted })
      } else {
        // Match the dotenv "last wins" semantic: rewrite the final
        // occurrence so the effective value at load time is the new one.
        // Earlier duplicates are dropped to avoid silent drift on the
        // next round-trip.
        const last = matches[matches.length - 1]
        lines[last] = { kind: 'kv', name: key, value, raw: formatted }
        for (let i = matches.length - 2; i >= 0; i -= 1) {
          lines.splice(matches[i], 1)
        }
      }
      written.push(key)
    }

    if (written.length === 0 && cleared.length === 0) {
      return { written, cleared }
    }

    // Allowlist filter is also a structural guard against accidental
    // `ALLOWED_KEY_SET` drift: keys still in the file but no longer
    // recognized are left alone (we only touch keys we own).
    // Reserved use of ALLOWED_KEY_SET — referenced here so the constant
    // is load-bearing in case a future filter lands.
    void ALLOWED_KEY_SET

    const text = lines.map((line) => line.raw).join('\n') + '\n'
    this.#atomicWrite(this.getEnvPath(), text)

    return { written, cleared }
  }

  /**
   * write tmp → rename. A crash between fs.writeFileSync and rename leaves
   * `.tmp` behind but `backend.env` itself stays consistent. `mkdirSync`
   * with `recursive: true` is idempotent so the first-ever write doesn't
   * need a separate ensureRuntimeFiles hop.
   */
  #atomicWrite(targetPath, text) {
    const tmpPath = `${targetPath}.tmp`
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(tmpPath, text, { encoding: 'utf-8' })
    fs.renameSync(tmpPath, targetPath)
  }
}

module.exports = {
  BackendEnvRepository,
  ALLOWED_KEYS,
  ENV_FILENAME
}
