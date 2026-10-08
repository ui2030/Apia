/**
 * 처음 켜는 사람을 위한 보조 규칙 (발주서 24).
 *
 *   firstRunDecision — 시작 안내 카드를 띄울지. 답변 모델이 생기면 영구 종료.
 *   helpLinkUrl      — 정보·도움 패널의 외부 링크. github.com만 연다.
 *   buildReportEntries — 문제 신고용 묶음. **읽는 곳을 logs 폴더 + 설정 파일로
 *     한정**하는 것이 제외 목록의 실체다(backend.env·DB·학습 노트·목소리·personal은
 *     애초에 열지 않는다). 읽은 내용에서도 키·토큰·사용자 이름을 지운다.
 */
const fs = require('fs')
const path = require('path')

const FIRST_RUN_MAX_DISMISS = 3

function firstRunDecision({ settings = {}, availableModes, hiddenThisRun = false }) {
  if (settings.firstRunDone === true) return { show: false, markDone: false }
  // 백엔드에 못 붙으면 모델이 있는지 모른다 — 연결 안내 띠가 따로 맡는다.
  if (!Array.isArray(availableModes)) return { show: false, markDone: false }
  if (availableModes.length > 0) return { show: false, markDone: true }
  if (hiddenThisRun || (settings.firstRunDismissCount || 0) >= FIRST_RUN_MAX_DISMISS) {
    return { show: false, markDone: false }
  }
  return { show: true, markDone: false }
}

const REPO_URL = 'https://github.com/ui2030/Apia'
const HELP_LINKS = Object.freeze({
  guide: `${REPO_URL}/blob/main/docs/user/${encodeURIComponent('설치하기.md')}`,
  privacy: `${REPO_URL}/blob/main/PRIVACY.md`
})

function isAllowedHelpUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'github.com'
  } catch {
    return false
  }
}

function helpLinkUrl(kind) {
  const url = Object.prototype.hasOwnProperty.call(HELP_LINKS, kind) ? HELP_LINKS[kind] : null
  return url && isAllowedHelpUrl(url) ? url : null
}

const REDACTED = '<지움>'
const SECRET_KEY_RE = /key|token|secret|password|auth/i

// 키 모양 문자열(sk-…, gsk_…, hf_…)과 "이름=값" 꼴의 비밀값. 경로의 사용자 이름은
// JSON 이스케이프(\\)까지 감안해 구분자 여러 개를 허용한다.
function scrubText(text, userName = '') {
  let out = String(text)
    .replace(/\b(sk-ant-|sk-|gsk_|hf_|tvly-|xai-)[A-Za-z0-9_\-]{8,}/g, REDACTED)
    // 대소문자·따옴표 무관: KEY=…, "api_key": "…", password: … (astra 지적)
    .replace(/(["']?)([A-Za-z0-9_\-]*(?:key|token|secret|password|auth)[A-Za-z0-9_\-]*)\1(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',}]+)/gi, `$1$2$1$3${REDACTED}`)
    .replace(/([A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+)[^\\/"'\s]+/gi, '$1<사용자>')
  // ponytail: 너무 짧은 이름은 일반 단어를 망가뜨리므로 경로 규칙만 믿는다.
  if (userName && userName.length >= 3) {
    out = out.split(userName).join('<사용자>')
  }
  return out
}

function sanitizeSettings(settings, userName) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? REDACTED : walk(v)
      }
      return out
    }
    return typeof value === 'string' ? scrubText(value, userName) : value
  }
  return walk(settings)
}

const LOG_FILE_RE = /\.log(\.\d+)?$/i

/** [{ name, data }] — zip 안 파일 이름과 내용. 읽는 곳은 logDir 바로 아래와 settingsPath뿐. */
function buildReportEntries({ logDir, settingsPath, summaryLines = [], userName = '' }) {
  const entries = []
  let logNames = []
  try { logNames = fs.readdirSync(logDir).filter((n) => LOG_FILE_RE.test(n)) } catch {}
  for (const name of logNames) {
    const full = path.join(logDir, name)
    try {
      if (!fs.lstatSync(full).isFile()) continue // 심볼릭 링크는 isFile=false → logs 밖을 가리키는 항목 거부
      entries.push({ name: `logs/${name}`, data: scrubText(fs.readFileSync(full, 'utf-8'), userName) })
    } catch {}
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    entries.push({ name: 'apia-settings.json', data: JSON.stringify(sanitizeSettings(raw, userName), null, 2) })
  } catch {}
  entries.push({ name: 'summary.txt', data: scrubText(summaryLines.join('\r\n'), userName) + '\r\n' })
  return entries
}

function reportStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

module.exports = {
  FIRST_RUN_MAX_DISMISS,
  firstRunDecision,
  HELP_LINKS,
  isAllowedHelpUrl,
  helpLinkUrl,
  scrubText,
  sanitizeSettings,
  buildReportEntries,
  reportStamp
}
