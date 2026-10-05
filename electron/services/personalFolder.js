// "내 파일" 폴더 — 개인 설정(사용자 소유). 앱 업데이트·재설치가 건드리지 않는다.
//
// 두 겹 규칙: 앱은 기본 설정(backend/defaults/)을 들고 다니고, 이 폴더에 같은
// 이름의 파일이 있으면 그게 기본을 **통째로 덮는다**(합치지 않음). 비우면 기본으로
// 돌아간다. 성격(persona.md)이 첫 적용이고, 목소리 참조 등도 같은 규칙을 따른다.
const fs = require('fs')
const path = require('path')

const PERSONA = 'persona.md'

const README = `이 폴더 = Apia 개인 설정 (내 파일)

앱은 기본 설정을 들고 다니고, 이 폴더에 파일이 있으면 그게 기본을 덮어씁니다.
이 폴더를 비우면(파일을 빼면) 기본 설정으로 돌아갑니다.
앱 업데이트·재설치는 이 폴더를 건드리지 않습니다.

구조:
  persona.md            캐릭터의 성격·말투 (UTF-8 텍스트, 8KB까지 읽음)
  voice/reference.wav   목소리 참조 (선택)
  그 밖의 하위 폴더는 자유롭게 써도 됩니다.

권장:
  - 가끔 이 폴더를 통째로 백업해 두세요.
  - OneDrive·Dropbox 같은 동기화 대상에서는 빼 두는 것이 좋습니다.
  - 설정 창의 [기본으로 되돌리기]는 persona.md를 지우지 않고
    persona.md.bak-날짜 로 이름만 바꿉니다.
`

/** 폴더·README 보장 + 옛 위치(backend-data/persona/persona.md)에서 1회 이동. */
function ensurePersonalFolder({ personalDir, legacyPersonaPath = null, log = console }) {
  fs.mkdirSync(personalDir, { recursive: true })
  const readme = path.join(personalDir, 'README.txt')
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, 'utf8')
  const target = path.join(personalDir, PERSONA)
  if (legacyPersonaPath && fs.existsSync(legacyPersonaPath)) {
    if (fs.existsSync(target)) {
      // 둘 다 있으면 개인 파일을 지키고 옛 파일은 이름만 바꿔 둔다 — 매 실행마다 경고하지 않게.
      fs.renameSync(legacyPersonaPath, `${legacyPersonaPath}.migrated`)
      log.warn?.('[PERSONAL_MIGRATE_SKIP] both exist, keeping personal; legacy renamed', legacyPersonaPath)
    } else {
      fs.renameSync(legacyPersonaPath, target)
      log.info?.('[PERSONAL_MIGRATED]', legacyPersonaPath, '->', target)
    }
  }
}

function personalStatus(personalDir) {
  return { dir: personalDir, personal: fs.existsSync(path.join(personalDir, PERSONA)) }
}

/** 개인 성격을 persona.md.bak-YYYYMMDD-HHMMSS로 옮겨 기본으로 복귀(삭제 아님). */
function resetPersona(personalDir, now = new Date()) {
  const src = path.join(personalDir, PERSONA)
  if (!fs.existsSync(src)) return { ok: true, backup: null }
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  let backup = `${src}.bak-${stamp}`
  for (let n = 2; fs.existsSync(backup); n += 1) backup = `${src}.bak-${stamp}-${n}` // 같은 초 충돌 회피
  fs.renameSync(src, backup)
  return { ok: true, backup }
}

module.exports = { ensurePersonalFolder, personalStatus, resetPersona }
