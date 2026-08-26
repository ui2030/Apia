/**
 * Tests for the apia-world.json write boundary.
 *
 * 읽기 경로는 이미 스키마로 지켜지고 있었지만 쓰기는 renderer가 준 걸 그대로
 * writeFileSync 했다 — 검증도, 원자성도, try/catch도 없었다. 여기서 세 가지를
 * 모두 확인한다: 거부 시 기존 파일 보존 / 성공 시 임시파일 미잔류 / 에러 반환.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveWorldDocument } = require('../electron/services/worldStore')

let tmpDir
let worldPath
let log

const validWorld = () => ({
  version: 1,
  objects: [
    { id: 'chair-1', type: 'chair', label: '의자', x: 0, y: 0, z: 0 }
  ]
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-world-'))
  worldPath = join(tmpDir, 'apia-world.json')
  log = { warn: vi.fn() }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('saveWorldDocument', () => {
  it('writes a valid document and leaves no tmp file behind', async () => {
    expect(saveWorldDocument(worldPath, validWorld(), log)).toEqual({ ok: true })
    const onDisk = JSON.parse(await readFile(worldPath, 'utf-8'))
    expect(onDisk.objects[0].id).toBe('chair-1')
    expect(await readdir(tmpDir)).toEqual(['apia-world.json'])
  })

  it('keeps unknown keys (passthrough) so a newer renderer field is not dropped', () => {
    saveWorldDocument(worldPath, { ...validWorld(), futureKey: 42 }, log)
    expect(JSON.parse(require('node:fs').readFileSync(worldPath, 'utf-8')).futureKey).toBe(42)
  })

  it('rejects a malformed document WITHOUT touching the existing file', async () => {
    await writeFile(worldPath, JSON.stringify(validWorld()), 'utf-8')

    const result = saveWorldDocument(worldPath, { objects: [{ id: 'x' }] }, log)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rejected/)
    expect(log.warn).toHaveBeenCalledWith('[WORLD_SAVE_REJECTED]', expect.objectContaining({
      issues: expect.any(Array)
    }))
    // 기존 세계가 그대로 살아 있다 — 이게 이 변경의 핵심.
    const onDisk = JSON.parse(await readFile(worldPath, 'utf-8'))
    expect(onDisk.objects[0].id).toBe('chair-1')
  })

  it('rejects a non-object payload instead of throwing', () => {
    expect(saveWorldDocument(worldPath, null, log).ok).toBe(false)
    expect(saveWorldDocument(worldPath, 'nope', log).ok).toBe(false)
  })

  it('rejects Infinity coordinates (hand-edited 1e9999 style input)', () => {
    const bad = validWorld()
    bad.objects[0].x = Infinity
    expect(saveWorldDocument(worldPath, bad, log).ok).toBe(false)
  })

  it('returns {ok:false} instead of throwing when the write itself fails', () => {
    // 디렉터리를 경로로 주면 rename이 실패한다(EPERM/EISDIR) — 예외가 renderer로
    // 새어 나가지 않고 ok:false로 돌아와야 한다.
    const result = saveWorldDocument(tmpDir, validWorld(), log)
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})

// 계약 테스트: 렌더러가 실제로 저장하는 문서가 이 쓰기 경계를 통과해야 한다.
// 통과 못 하면 사용자의 방 배치가 조용히 저장 안 되는(그리고 아무도 모르는)
// 회귀가 된다 — 스키마를 도입한 이번 변경의 유일한 위험이라 여기서 못 박는다.
describe('renderer가 만드는 기본 월드', () => {
  it('createDefaultWorld() 결과가 그대로 저장된다', async () => {
    const { createDefaultWorld } = await import('../src/world.js')
    expect(saveWorldDocument(worldPath, createDefaultWorld(), log)).toEqual({ ok: true })
    expect(log.warn).not.toHaveBeenCalled()
  })
})
