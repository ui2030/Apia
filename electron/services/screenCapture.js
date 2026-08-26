/**
 * 관전 모드 화면 캡처 + 절약 게이트 (M2).
 *
 * 프라이버시 계약: **창 단위만 캡처한다.** `types`에 'screen'을 절대 넣지
 * 않으므로 전체 화면·다른 모니터가 소스 목록에 오르지도, 캡처되지도 않는다.
 * 사용자가 고른 창 하나가 사라지면 캡처는 그냥 실패하고(no-source) 조용히 쉰다.
 *
 * 절약 게이트: VLM은 호출당 돈이 든다. 화면이 사실상 안 변했으면 부를 이유가
 * 없으므로 320x180 그레이스케일 평균 절대차로 먼저 거른다. **이건 트리거가
 * 아니라 절약 장치다** — 게임 화면은 늘 변하므로 diff를 트리거로 쓰면 상시
 * 발화하거나(임계 낮음) 영영 침묵한다(임계 높음). 발화 주기는 러너가 정한다.
 *
 * 순수 함수(toGray/frameDiff/frameStats/isDeadFrame)는 Electron 없이 도는
 * 계산이라 단위테스트가 여기 걸린다. desktopCapturer를 만지는 부분만 비순수.
 */

const DIFF_W = 320
const DIFF_H = 180

/** BGRA 버퍼 → 그레이스케일 Uint8Array. Rec.601 정수 근사(>>8). */
function toGray(bgra) {
  const out = new Uint8Array(Math.floor(bgra.length / 4))
  for (let i = 0, j = 0; j < out.length; i += 4, j += 1) {
    out[j] = (bgra[i + 2] * 77 + bgra[i + 1] * 150 + bgra[i] * 29) >> 8
  }
  return out
}

/** 두 그레이 프레임의 평균 절대차(0..255). 비교 불가면 Infinity =「변했다」로
 *  취급한다 — 첫 프레임이나 창 크기 변경에서 안전한 쪽(호출)으로 넘어간다. */
function frameDiff(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/** 평균/분산 — 검은 화면·단색 화면 판정용. */
function frameStats(gray) {
  if (!gray || gray.length === 0) return { mean: 0, variance: 0 }
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < gray.length; i += 1) {
    sum += gray[i]
    sumSq += gray[i] * gray[i]
  }
  const mean = sum / gray.length
  return { mean, variance: Math.max(0, sumSq / gray.length - mean * mean) }
}

/**
 * 「죽은 프레임」 — 캡처는 성공했는데 내용이 없는 경우. 전용(exclusive)
 * 전체화면 게임을 창 캡처하면 보통 검은 프레임이 나온다. Electron에는 타
 * 프로세스의 전용 전체화면을 신뢰성 있게 감지하는 API가 없어서, 이 신호를
 * 대신 쓴다(Codex 사전검토 합의 — bounds 비교식 추측은 하지 않는다).
 */
function isDeadFrame(gray) {
  const { mean, variance } = frameStats(gray)
  return mean < 8 || variance < 4
}

/**
 * 창 목록. 썸네일 0x0으로 요청해 목록 조회 비용을 없앤다(아이콘/미리보기
 * 불필요 — 사용자는 이름으로 고른다).
 */
async function listWindows(desktopCapturer) {
  const sources = await desktopCapturer.getSources({
    types: ['window'], // 'screen' 금지 — 프라이버시 계약
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  return sources
    .filter((s) => s.name && s.name.trim())
    .map((s) => ({ id: s.id, name: s.name }))
}

/**
 * 캡처 게이트 1개(관전 세션당 1개). 이전 프레임을 들고 있어야 diff가 되므로
 * 클로저로 상태를 잡는다. `deps`는 테스트에서 주입 가능.
 */
function createCaptureGate({ desktopCapturer, diffThreshold = 6, captureSize = { width: 1280, height: 720 } } = {}) {
  let prevGray = null
  let deadStreak = 0

  return {
    reset() {
      prevGray = null
      deadStreak = 0
    },
    deadStreak: () => deadStreak,
    /**
     * @returns {{status:'no-source'}|{status:'dead-frame',deadStreak:number}
     *           |{status:'no-change',diff:number}|{status:'ok',diff:number,dataUrl:string}}
     */
    async capture(sourceId) {
      // 1단계 — 게이트용 320x180만 받는다. 예전엔 720p를 먼저 렌더한 뒤 줄여서
      // 게이트를 돌렸는데, 거절되는 프레임(대부분)에서도 1280x720 렌더 비용을
      // 다 내고 버리는 셈이었다.
      const probe = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: DIFF_W, height: DIFF_H },
        fetchWindowIcons: false
      })
      const probeHit = probe.find((s) => s.id === sourceId)
      if (!probeHit || !probeHit.thumbnail || probeHit.thumbnail.isEmpty()) return { status: 'no-source' }

      const gray = toGray(probeHit.thumbnail.toBitmap())

      if (isDeadFrame(gray)) {
        deadStreak += 1
        prevGray = gray
        return { status: 'dead-frame', deadStreak }
      }
      deadStreak = 0

      const diff = frameDiff(prevGray, gray)
      prevGray = gray
      if (diff < diffThreshold) return { status: 'no-change', diff }

      // 2단계 — 게이트를 통과한 프레임만 전송 해상도로 다시 받는다. Electron엔
      // source id 하나만 다시 렌더하는 API가 없어 통과 경로는 열거를 두 번 치른다.
      // 이득은 압도적으로 흔한 거절 경로 쪽에 있다.
      const full = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: captureSize,
        fetchWindowIcons: false
      })
      const hit = full.find((s) => s.id === sourceId)
      // 두 호출 사이에 창이 닫히거나 최소화될 수 있다. prevGray는 이미 방금
      // 프레임으로 전진해 있으니 다음 틱은 그 기준으로 정상 비교된다.
      if (!hit || !hit.thumbnail || hit.thumbnail.isEmpty()) return { status: 'no-source' }

      // JPEG로 보낸다 — PNG는 스크린샷에서 몇 배 크고, VLM 입력엔 손실압축으로 충분.
      return { status: 'ok', diff, dataUrl: hit.thumbnail.toJPEG(70).toString('base64') }
    }
  }
}

module.exports = {
  DIFF_W,
  DIFF_H,
  toGray,
  frameDiff,
  frameStats,
  isDeadFrame,
  listWindows,
  createCaptureGate
}
