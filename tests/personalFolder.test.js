import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensurePersonalFolder, personalStatus, resetPersona } = require('../electron/services/personalFolder')

const quiet = { info() {}, warn() {} }
let root, personalDir, legacy

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'apia-personal-'))
  personalDir = path.join(root, 'personal')
  legacy = path.join(root, 'backend-data', 'persona', 'persona.md')
})

describe('personalFolder', () => {
  it('creates the folder + README once; empty folder means default layer', () => {
    ensurePersonalFolder({ personalDir, log: quiet })
    const readme = path.join(personalDir, 'README.txt')
    expect(fs.readFileSync(readme, 'utf8')).toContain('기본 설정으로 돌아갑니다')
    fs.writeFileSync(readme, 'user edit')
    ensurePersonalFolder({ personalDir, log: quiet })
    expect(fs.readFileSync(readme, 'utf8')).toBe('user edit') // 덮어쓰지 않는다
    expect(personalStatus(personalDir).personal).toBe(false)
  })

  it('moves the legacy persona once, never over an existing personal one', () => {
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, '테스트용 캐릭터')
    ensurePersonalFolder({ personalDir, legacyPersonaPath: legacy, log: quiet })
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.readFileSync(path.join(personalDir, 'persona.md'), 'utf8')).toBe('테스트용 캐릭터')
    expect(personalStatus(personalDir).personal).toBe(true)

    fs.writeFileSync(legacy, '옛 사본')
    ensurePersonalFolder({ personalDir, legacyPersonaPath: legacy, log: quiet })
    expect(fs.readFileSync(path.join(personalDir, 'persona.md'), 'utf8')).toBe('테스트용 캐릭터')
    expect(fs.existsSync(legacy)).toBe(false)              // 옛 파일은 .migrated로 이름만 바뀐다(매 실행 경고 방지)
    expect(fs.existsSync(`${legacy}.migrated`)).toBe(true)
  })

  it('reset keeps a .bak and returns to the default layer', () => {
    ensurePersonalFolder({ personalDir, log: quiet })
    fs.writeFileSync(path.join(personalDir, 'persona.md'), '테스트용 캐릭터')
    const res = resetPersona(personalDir, new Date(2026, 0, 2, 3, 4, 5))
    expect(res.backup).toBe(path.join(personalDir, 'persona.md.bak-20260102-030405'))
    expect(fs.readFileSync(res.backup, 'utf8')).toBe('테스트용 캐릭터')
    expect(personalStatus(personalDir).personal).toBe(false)
    expect(resetPersona(personalDir).backup).toBeNull() // 이미 기본이면 아무 일 없음
  })
})
