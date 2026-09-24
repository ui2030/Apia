/**
 * 교재 파이프라인 — 그날의 대화를 버퍼에 적고, 지난 날짜의 버퍼를 교사 API가
 * 익명 교재 카드로 바꾸고, **바꾸기에 성공한 뒤에만** 원본을 지운다.
 *
 * 이 모듈은 학습을 하지 않는다. 캐릭터의 말·화제 선택·알림에 연결된 출구가
 * 하나도 없다(연결은 뒷 단계 몫). 눈치 원장(topicLedger.js)과는 훅 지점만
 * 공유하고 코드는 독립이다.
 *
 * 폐기 규칙(이 파일에서 가장 중요한 불변식):
 *   버퍼 파일을 지우는 경로는 commitCourseware() **하나뿐**이고, 그 안에서도
 *   교재 파일을 fsync→rename→되읽기 검증까지 마친 뒤에만 unlink한다. 검증
 *   단계 중 어디서든 던지면 버퍼는 그대로 남고 다음 기회에 재시도한다.
 *
 * 저장 위치는 userData 아래 courseware/ — apia-world.json·apia-settings.json과
 * 같은 규약(Windows: %APPDATA%\apia). OneDrive/Dropbox 같은 동기화 폴더가 아니다.
 */
const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 2
const FAILURE_WARN_STREAK = 7 // 이만큼 연속 실패하면 원본을 유지한 채 경고를 적는다
const SPEND_WINDOW_DAYS = 7

const README_TEXT = [
  '이 폴더는 Apia 교재 파이프라인의 작업 공간입니다.',
  '',
  'buffers/  — 아직 교재로 바뀌지 않은 날의 대화 원문. 변환에 성공하면 자동으로 지워집니다.',
  'cards/    — 익명화된 복습 교재(일자별 JSONL).',
  'status.json — 변환 상태·비용 기록.',
  '',
  '백업·클라우드 동기화 대상에서 제외하세요. 대화 원문이 들어 있고,',
  '동기화된 사본은 변환 성공 후에도 원본이 남아 폐기 규칙을 무력화합니다.',
  ''
].join('\n')

function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

function emptyStatus() {
  return {
    schema_version: SCHEMA_VERSION,
    lastConvertedAt: null,
    // 일자별 카드 수. 누적 카운터가 아니라 **일자 → 수** 지도인 게 중요하다:
    // 같은 날을 두 번 확정해도 값이 덮어써질 뿐 이중 집계가 구조적으로 불가능하다.
    cardCounts: {},
    spend: {},       // dayKey -> usd (교사 호출이 일어난 날 기준, 최근 7일만 보존)
    failures: {},    // 버퍼 dayKey -> 연속 실패 횟수
    warnings: [],    // { day, streak, at } — 7일 연속 실패한 버퍼
    lastError: null  // { at, day, message }
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dir     courseware 루트 (userData 안)
 * @param {() => number} [deps.now]
 * @param {object} [deps.fsImpl] 테스트에서 쓰기/삭제 실패를 주입하기 위한 seam
 */
function createCoursewareStore({ dir, now = () => Date.now(), fsImpl = fs, log = {} } = {}) {
  if (!dir) throw new Error('createCoursewareStore: dir required')

  const buffersDir = path.join(dir, 'buffers')
  const cardsDir = path.join(dir, 'cards')
  const statusPath = path.join(dir, 'status.json')

  let status = null
  // 버퍼 append를 직렬화하는 꼬리 promise. 채팅 경로는 이 promise를 기다리지
  // 않는다(호출자가 버린다) — 디스크 쓰기가 응답 지연에 들어가지 않게.
  let appendChain = Promise.resolve()
  // 변환 중인 일자. 이 일자로 들어오는 늦은 기록은 오늘자 버퍼로 승격된다 —
  // 그러지 않으면 unlink 뒤에 도착한 한 건이 옛 버퍼를 되살리고, 다음 실행이
  // 그 하루치 교재를 그 한 건만으로 덮어쓴다.
  let heldDay = null

  function ensureDir(target) {
    fsImpl.mkdirSync(target, { recursive: true })
  }

  function ensureReadme() {
    const readmePath = path.join(dir, 'README.txt')
    try {
      ensureDir(dir)
      if (!fsImpl.existsSync(readmePath)) fsImpl.writeFileSync(readmePath, README_TEXT, 'utf-8')
    } catch {}
  }

  function loadStatus() {
    if (status) return status
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(statusPath, 'utf-8'))
      status = parsed?.schema_version === SCHEMA_VERSION ? { ...emptyStatus(), ...parsed } : emptyStatus()
    } catch {
      status = emptyStatus() // 없거나 깨졌으면 새로 시작 — 버퍼/교재는 파일 자체가 정본이다
    }
    return status
  }

  /** tmp→rename 원자적 쓰기. 실패해도 기존 status.json은 그대로 둔다. */
  function saveStatus() {
    const s = loadStatus()
    const tmpPath = `${statusPath}.tmp`
    try {
      ensureDir(dir)
      fsImpl.writeFileSync(tmpPath, JSON.stringify(s, null, 2), 'utf-8')
      fsImpl.renameSync(tmpPath, statusPath)
      return { ok: true }
    } catch (error) {
      try { fsImpl.unlinkSync(tmpPath) } catch {}
      log.warn?.('[COURSEWARE_STATUS_WRITE_FAILED]', error?.message || error)
      return { ok: false, error: error?.message || String(error) }
    }
  }

  const bufferPath = (day) => path.join(buffersDir, `${day}.jsonl`)
  const cardsPath = (day) => path.join(cardsDir, `${day}.jsonl`)

  /**
   * 교환 1건을 그날 버퍼에 덧붙인다. 일자는 **호출 시각**으로 확정하고(자정을
   * 넘긴 뒤 flush돼도 어제 파일로 간다) 쓰기는 비동기 큐로 뺀다.
   * 반환 promise는 테스트용 — 대화 경로는 기다리지 않는다.
   *
   * 예외 하나: 그 일자가 지금 변환 중이면 오늘자 버퍼로 승격한다. 원문의 시각
   * (t)은 줄 안에 그대로 남으므로 기록 자체는 잃지 않는다.
   */
  function appendExchange({ u, a, t } = {}) {
    const at = Number.isFinite(t) ? t : now()
    const user = String(u == null ? '' : u)
    const assistant = String(a == null ? '' : a)
    if (!user.trim() && !assistant.trim()) return appendChain
    const bucket = dayKeyOf(at)
    const file = bufferPath(bucket === heldDay ? dayKeyOf(now()) : bucket)
    const line = `${JSON.stringify({ t: at, u: user, a: assistant })}\n`
    appendChain = appendChain.then(() => new Promise((resolve) => {
      fsImpl.mkdir(buffersDir, { recursive: true }, () => {
        fsImpl.appendFile(file, line, 'utf-8', (error) => {
          if (error) log.warn?.('[COURSEWARE_BUFFER_APPEND_FAILED]', error?.message || error)
          resolve()
        })
      })
    }))
    return appendChain
  }

  /**
   * 한 일자를 변환 대상으로 붙잡는다. 반환된 함수를 부를 때까지 그 일자로 오는
   * 기록은 오늘자로 승격된다. **drain보다 먼저** 불러야 한다 — 순서가 뒤집히면
   * drain을 기다리는 동안 들어온 기록이 다시 그 일자 버퍼에 쌓인다.
   */
  function holdDay(day) {
    heldDay = day
    return () => { if (heldDay === day) heldDay = null }
  }

  /** 지금까지 큐에 들어간 append가 전부 디스크에 닿을 때까지. */
  function drainAppends() {
    return appendChain
  }

  function listDays(target) {
    try {
      return fsImpl.readdirSync(target)
        .map((name) => DAY_FILE_RE.exec(name)?.[1])
        .filter(Boolean)
        .sort()
    } catch {
      return []
    }
  }

  /** 오늘 이전의 미변환 버퍼 일자(오래된 순). 오늘 버퍼는 아직 열려 있으므로 제외. */
  function pendingDays() {
    const today = dayKeyOf(now())
    return listDays(buffersDir).filter((day) => day < today)
  }

  function readBuffer(day) {
    let text
    try { text = fsImpl.readFileSync(bufferPath(day), 'utf-8') } catch { return [] }
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object') out.push({ t: obj.t, u: String(obj.u || ''), a: String(obj.a || '') })
      } catch {} // 반쯤 쓰인 마지막 줄은 버린다 — 그 교환 하나를 잃을 뿐이다
    }
    return out
  }

  /**
   * 교재를 확정하고 **그 뒤에** 원본 버퍼를 지운다.
   *
   * 순서: tmp 쓰기 → fsync → rename → 되읽기 검증 → 버퍼 unlink.
   * 앞의 어느 단계든 던지면 버퍼는 살아남는다. 이 함수 바깥에 버퍼를 지우는
   * 코드는 없다.
   */
  function commitCourseware(day, cards) {
    const list = Array.isArray(cards) ? cards : []
    const text = list
      .map((c) => JSON.stringify({ day, u: String(c?.u || ''), a: String(c?.a || '') }))
      .map((line) => `${line}\n`)
      .join('')
    const target = cardsPath(day)
    const tmpPath = `${target}.tmp`

    try {
      ensureDir(cardsDir)
      const fd = fsImpl.openSync(tmpPath, 'w')
      try {
        fsImpl.writeFileSync(fd, text, 'utf-8')
        fsImpl.fsyncSync(fd) // 디스크에 닿기 전에 원본을 지우지 않는다
      } finally {
        fsImpl.closeSync(fd)
      }
      fsImpl.renameSync(tmpPath, target)
      if (fsImpl.readFileSync(target, 'utf-8') !== text) throw new Error('courseware readback mismatch')
    } catch (error) {
      try { fsImpl.unlinkSync(tmpPath) } catch {}
      return noteFailure(day, `write failed: ${error?.message || error}`)
    }

    // 여기부터가 "성공이 디스크에 확정된" 뒤다.
    try {
      fsImpl.unlinkSync(bufferPath(day))
    } catch (error) {
      // 교재는 남았는데 버퍼가 안 지워진 경우. 다음 실행의 reconcileExisting이
      // 교사를 부르지 않고 버퍼만 닫는다 — 재호출도 이중 집계도 없다.
      log.warn?.('[COURSEWARE_BUFFER_UNLINK_FAILED]', day, error?.message || error)
    }

    const s = loadStatus()
    s.cardCounts[day] = list.length // 덮어쓰기 — 같은 날을 두 번 확정해도 이중 집계 없음
    s.lastConvertedAt = now()
    delete s.failures[day]
    s.warnings = s.warnings.filter((w) => w.day !== day)
    s.lastError = null
    saveStatus()
    return { ok: true, day, cards: list.length }
  }

  /**
   * 그 일자의 교재 파일이 이미 온전히 있으면 카드 수를, 없거나 깨졌으면 null.
   * "온전하다"는 모든 줄이 u/a를 가진 JSON이라는 뜻이다 — commitCourseware가
   * rename으로만 파일을 만드니 반쪽짜리는 원리상 없지만, 재실행이 교사를
   * 건너뛸지 판단하는 근거라 직접 확인한다. 빈 파일(0장)도 유효한 결과다.
   */
  function verifiedCardCount(day) {
    let text
    try { text = fsImpl.readFileSync(cardsPath(day), 'utf-8') } catch { return null }
    let count = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const card = JSON.parse(line)
        if (!card || typeof card.u !== 'string' || typeof card.a !== 'string') return null
        count += 1
      } catch { return null }
    }
    return count
  }

  /**
   * 크래시·unlink 실패로 "교재는 확정됐는데 버퍼가 남은" 상태를 교사 호출 없이
   * 닫는다. 이미 있는 교재를 다시 만들 이유가 없고(돈), 다시 만들면 그날의
   * 카드가 남은 버퍼 한 조각으로 줄어든다(데이터 손실).
   * 해당 교재가 없거나 깨졌으면 null — 정상 변환 경로로 보낸다.
   */
  function reconcileExisting(day) {
    const count = verifiedCardCount(day)
    if (count == null) return null
    try {
      fsImpl.unlinkSync(bufferPath(day))
    } catch (error) {
      log.warn?.('[COURSEWARE_BUFFER_UNLINK_FAILED]', day, error?.message || error)
    }
    const s = loadStatus()
    s.cardCounts[day] = count
    delete s.failures[day]
    s.warnings = s.warnings.filter((w) => w.day !== day)
    s.lastError = null
    saveStatus()
    return { ok: true, day, cards: count, reconciled: true }
  }

  /** 변환 실패 1회. 원본은 건드리지 않는다. 7일 연속이면 경고를 남긴다. */
  function noteFailure(day, message) {
    const s = loadStatus()
    const streak = (s.failures[day] || 0) + 1
    s.failures[day] = streak
    s.lastError = { at: now(), day, message: String(message || '').slice(0, 300) }
    if (streak >= FAILURE_WARN_STREAK && !s.warnings.some((w) => w.day === day)) {
      s.warnings.push({ day, streak, at: now() })
    }
    saveStatus()
    return { ok: false, day, error: s.lastError.message, streak }
  }

  /** 교사 호출이 없었던 연기(백엔드 꺼짐·키 없음·예산 소진). 실패로 세지 않는다. */
  function noteDeferral(day, message) {
    const s = loadStatus()
    s.lastError = { at: now(), day, message: String(message || '').slice(0, 300) }
    saveStatus()
    return { ok: false, day, deferred: true, error: s.lastError.message }
  }

  /** 교사가 돌려준 당일 지출 누계를 기록한다. 최근 7일만 남긴다. */
  function noteSpend(usd) {
    const value = Number(usd)
    if (!Number.isFinite(value)) return
    const s = loadStatus()
    s.spend[dayKeyOf(now())] = value
    const keep = new Set(
      Array.from({ length: SPEND_WINDOW_DAYS }, (_, i) => dayKeyOf(now() - i * 86400000))
    )
    for (const day of Object.keys(s.spend)) if (!keep.has(day)) delete s.spend[day]
    saveStatus()
  }

  /** 설정 창 표시용 스냅샷. */
  function getState() {
    const s = loadStatus()
    const pending = pendingDays()
    return {
      schema_version: s.schema_version,
      lastConvertedAt: s.lastConvertedAt,
      totalCards: Object.values(s.cardCounts).reduce((a, b) => a + b, 0),
      cardDays: listDays(cardsDir).length,
      pendingDays: pending.length,
      oldestPendingDay: pending[0] || null,
      spend7d: Object.values(s.spend).reduce((a, b) => a + b, 0),
      spend: { ...s.spend },
      warnings: s.warnings.slice(),
      lastError: s.lastError,
      path: dir
    }
  }

  ensureReadme()

  return {
    appendExchange,
    holdDay,
    drainAppends,
    pendingDays,
    readBuffer,
    verifiedCardCount,
    reconcileExisting,
    commitCourseware,
    noteFailure,
    noteDeferral,
    noteSpend,
    getState,
    paths: { dir, buffersDir, cardsDir, statusPath, bufferPath, cardsPath }
  }
}

/**
 * 변환 잡 — 유휴일 때 지난 날짜 버퍼 **한 개**를 교재로 바꾼다.
 *
 * 한 번에 하루만 돈다: 밀린 날이 많아도 교사 호출이 한꺼번에 터지지 않고,
 * 예산 가드가 다음 호출에서 제때 걸린다.
 *
 * @param {(day: string, exchanges: object[]) => Promise<object>} deps.convert
 *   백엔드 호출. `{ status: 'ok'|'deferred'|'failed', cards, reason, spent_today }`
 */
function createCoursewareJob({ store, convert, isIdle = () => true } = {}) {
  if (!store || typeof convert !== 'function') {
    throw new Error('createCoursewareJob: store and convert required')
  }
  let running = false

  async function runOnce({ force = false } = {}) {
    if (running) return { skipped: 'running' }
    running = true
    let release = null
    try {
      // 순서가 계약이다.
      //  (1) 먼저 큐를 비운다 — 아직 디스크에 안 닿은 교환이 있으면 버퍼 파일
      //      자체가 안 보이거나, 보이더라도 일부만 읽고 원본을 지우게 된다.
      //  (2) 일자를 고르고 붙잡는다.
      //  (3) 한 번 더 비운다 — (1)을 기다리는 사이 새로 들어온 기록까지.
      //      붙잡은 뒤라서 이후 도착분은 오늘자로 새고, 그 일자 버퍼는 고정된다.
      await store.drainAppends()
      const days = store.pendingDays()
      if (days.length === 0) return { skipped: 'none' }
      if (!force && !isIdle()) return { skipped: 'busy' }

      const day = days[0]
      release = store.holdDay(day)
      await store.drainAppends()

      // 이미 확정된 교재가 있으면(unlink 실패·크래시 뒤 재실행) 교사를 다시
      // 부르지 않는다 — 돈도 아끼고 그날 카드가 남은 조각으로 줄어들지도 않는다.
      const reconciled = store.reconcileExisting(day)
      if (reconciled) return reconciled

      const exchanges = store.readBuffer(day)
      // 빈 버퍼는 교사를 부를 이유가 없다 — 같은 확정 경로로 닫는다.
      if (exchanges.length === 0) return store.commitCourseware(day, [])

      let res
      try {
        res = await convert(day, exchanges)
      } catch (error) {
        // 백엔드 미가동·네트워크 실패 = 조용한 연기. 원본은 그대로.
        return store.noteDeferral(day, error?.message || String(error))
      }

      if (Number.isFinite(res?.spent_today)) store.noteSpend(res.spent_today)

      if (res?.status === 'ok' && Array.isArray(res.cards)) {
        return store.commitCourseware(day, res.cards)
      }
      if (res?.status === 'deferred') return store.noteDeferral(day, res?.reason || 'deferred')
      return store.noteFailure(day, res?.reason || 'teacher returned no cards')
    } finally {
      release?.()
      running = false
    }
  }

  return { runOnce }
}

module.exports = {
  SCHEMA_VERSION,
  FAILURE_WARN_STREAK,
  dayKeyOf,
  createCoursewareStore,
  createCoursewareJob
}
