/**
 * apia-world.json 쓰기 경계.
 *
 * 읽기 쪽(main.js load-world)은 이미 엄격하다 — 봉투 스키마 + 오브젝트별 복구.
 * 쓰기 쪽은 renderer가 준 걸 그대로 writeFileSync 하고 있어서, 렌더러 버그
 * 하나가 세계 파일을 통째로 못 읽는 상태로 만들 수 있었다(그러면 다음 실행에
 * 방이 빈 채로 뜬다). 여기서 스키마 검증 + tmp→rename 원자적 쓰기로 막는다.
 */
const fs = require('fs')
const path = require('path')

const { WorldDocumentSchema } = require('../schemas')

/**
 * @returns {{ok: true}|{ok: false, error: string}} — 실패하면 **아무것도 쓰지 않는다**.
 */
function saveWorldDocument(worldPath, data, log = {}) {
  const parsed = WorldDocumentSchema.safeParse(data)
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    log.warn?.('[WORLD_SAVE_REJECTED]', { issues: summary, total: parsed.error.issues.length })
    return { ok: false, error: `world document rejected: ${summary.join('; ')}` }
  }

  const tmpPath = `${worldPath}.tmp`
  try {
    fs.mkdirSync(path.dirname(worldPath), { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(parsed.data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, worldPath)
    return { ok: true }
  } catch (error) {
    log.warn?.('[WORLD_SAVE_ERROR]', error?.message || error)
    return { ok: false, error: error?.message || String(error) }
  }
}

module.exports = { saveWorldDocument }
