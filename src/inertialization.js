// F단계 — 클립 전환 inertialization (GDC 2018 David Bollo 방식의 간소판).
//
// 크로스페이드(두 자세의 가중평균)는 전환 중 어느 쪽도 아닌 "죽은" 자세를
// 지나간다. inertialization은 전환 순간 화면 자세와 새 클립 자세의 차이
// (offset 회전)와 화면 자세의 각속도를 스냅샷하고, 그 offset을 임계감쇠
// 스프링으로 0까지 줄이며 새 클립 위에 얹는다 — 이전 모션의 관성이
// 자연스럽게 이어진다.
//
// 설계 결정 (Codex 사전 검토 3라운드 합의):
// - offset 기준 포즈는 클립 모델이 아니라 **실제 mixer 출력 실측**.
//   markInertialTransition은 pending 플래그만 세우고, 전환 후 첫
//   applyInertialization 호출이 "직전 프레임 표시 자세 캐시 vs 지금 본에
//   적힌 자세"의 차이를 측정한다. fadeIn 잔여 크로스페이드든 뭐든 실제
//   출력 기준이라 첫 프레임 연속성이 보장되고 과보정이 없다.
// - 합성은 좌측 고정: displayed = exp(x) · q_anim. 따라서
//   x0 = log(q_displayed · q_anim⁻¹), 적용은 premultiply.
// - 호출 지점: helper.update() **후**(mixer가 MMDAnimationHelper 내부
//   소유라 사이에 끼어들 자리가 없음), updateBody() 전. IK/Grant/물리는
//   보정 전 자세를 읽지만, 추적 본이 상체 8개뿐이라 다리 IK와 무관하고
//   offset은 ~0.35s에 소멸해 옷 물리의 1프레임 지연은 시각적으로 무시
//   가능 — 수용하고 여기 기록한다.
// - 추적 본에서 머리/목 제외: gaze 레이어(절차적)와 소유권이 겹친다.
// - 표시 자세 캐시·속도 추정은 updateBody까지 끝난 **최종** 자세에서
//   (recordDisplayedPose). 클립→클립이든 절차→클립이든 화면 연속성 기준.
// - 클립→절차 핸드오프(releaseActiveClips)는 범위 외 — 타깃 자세가 없어
//   기존 fade+spring decay 유지.
import { Quaternion, Vector3 } from 'three'

export const INERTIAL_BONES = [
  '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', '上半身', '上半身2'
]

const OMEGA = 13                  // 임계감쇠 ω — 정착 ≈ 4.6/ω ≈ 0.35s
const VELOCITY_RESET_DT = 0.1     // 프레임 간격이 이 밖이면 속도 추정 불신 (Codex)
const MAX_VELOCITY = 10           // rad/s — 스파이크 속도 클램프
const DONE_EPS = 1e-3             // offset·속도가 이 아래로 떨어지면 종료

let _enabled = true

/** E2E 비교 측정용 토글 (window.__setInertialization) */
export function setInertializationEnabled(on) {
  _enabled = on !== false
}

const _tmpQ = new Quaternion()
const _tmpInv = new Quaternion()
const _tmpV = new Vector3()

// q(단위 쿼터니언) → 회전 벡터(축×각). w<0이면 부호 반전해 최단호 보장.
function quatToRotVec(q, out) {
  let { x, y, z, w } = q
  if (w < 0) { x = -x; y = -y; z = -z; w = -w }
  const s = Math.sqrt(x * x + y * y + z * z)
  if (s < 1e-8) return out.set(0, 0, 0)
  const angle = 2 * Math.atan2(s, w)
  return out.set((x / s) * angle, (y / s) * angle, (z / s) * angle)
}

function rotVecToQuat(v, out) {
  const a = v.length()
  if (a < 1e-8) return out.set(0, 0, 0, 1)
  const s = Math.sin(a / 2) / a
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(a / 2))
}

function ensureState(model) {
  if (!model._inertial) {
    model._inertial = { pending: false, resolved: false, bones: new Map() }
  }
  return model._inertial
}

// 본 참조는 모델당 한 번 해석. 이름이 없는 본은 그냥 빠진다(모델 어댑터
// 원칙 — PMX 전용 가정으로 죽지 않기).
function resolveBones(model) {
  const st = ensureState(model)
  if (st.resolved) return st
  const skeleton = model.obj?.skeleton
  if (!skeleton) return st
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  for (const name of INERTIAL_BONES) {
    const bone = byName.get(name)
    if (!bone) continue
    st.bones.set(name, {
      bone,
      displayed: new Quaternion(),
      hasDisplayed: false,
      vel: new Vector3(),
      velValid: false,
      x: new Vector3(),
      v: new Vector3(),
      active: false
    })
  }
  st.resolved = true
  return st
}

/**
 * 클립 전환 직후 호출(animationRuntime) — 다음 applyInertialization이
 * 실측 스냅샷을 뜬다.
 */
export function markInertialTransition(model) {
  if (!model) return
  ensureState(model).pending = true
}

/**
 * 매 프레임, helper.update() 직후 · updateBody() 전에 호출.
 * pending이면 본별로 (직전 표시 자세, 지금 본에 적힌 mixer 출력)을 동시
 * 샘플해 offset/속도를 시작하고, active인 본은 감쇠를 한 스텝 진행해
 * offset을 premultiply한다.
 */
export function applyInertialization(model, dt) {
  if (!model?.obj) return
  const state = resolveBones(model)
  if (!state.bones.size) return

  if (state.pending) {
    state.pending = false
    if (_enabled) {
      for (const entry of state.bones.values()) {
        // 첫 전환인데 표시 캐시가 아직 없으면 점프 정보가 없다 — 무보정 시작
        if (!entry.hasDisplayed) {
          entry.active = false
          continue
        }
        // x0 = log(q_displayed · q_anim⁻¹) — q_anim은 지금 본에 적힌 실제 출력
        _tmpInv.copy(entry.bone.quaternion).invert()
        _tmpQ.copy(entry.displayed).multiply(_tmpInv)
        quatToRotVec(_tmpQ, entry.x)
        if (entry.velValid) {
          entry.v.copy(entry.vel)
          if (entry.v.length() > MAX_VELOCITY) entry.v.setLength(MAX_VELOCITY)
        } else {
          entry.v.set(0, 0, 0)
        }
        entry.active = entry.x.length() > DONE_EPS || entry.v.length() > DONE_EPS
      }
    }
  }

  if (!_enabled) {
    for (const entry of state.bones.values()) entry.active = false
    return
  }

  const clampedDt = Math.min(Math.max(dt, 0), VELOCITY_RESET_DT)
  if (clampedDt <= 0) return
  for (const entry of state.bones.values()) {
    if (!entry.active) continue
    // 임계감쇠: x'' = -2ω·x' - ω²·x (poseRig 스프링과 같은 꼴, 타깃 0)
    entry.v.x += -(2 * OMEGA * entry.v.x + OMEGA * OMEGA * entry.x.x) * clampedDt
    entry.v.y += -(2 * OMEGA * entry.v.y + OMEGA * OMEGA * entry.x.y) * clampedDt
    entry.v.z += -(2 * OMEGA * entry.v.z + OMEGA * OMEGA * entry.x.z) * clampedDt
    entry.x.x += entry.v.x * clampedDt
    entry.x.y += entry.v.y * clampedDt
    entry.x.z += entry.v.z * clampedDt
    if (entry.x.length() < DONE_EPS && entry.v.length() < DONE_EPS) {
      entry.active = false
      continue
    }
    rotVecToQuat(entry.x, _tmpQ)
    entry.bone.quaternion.premultiply(_tmpQ)
  }
}

/**
 * 매 프레임, updateBody()까지 끝난 뒤 호출 — 화면에 나가는 최종 자세를
 * 캐시하고 표시 각속도를 추정한다. 다음 전환의 연속성 기준점.
 */
export function recordDisplayedPose(model, dt) {
  const st = model?._inertial
  if (!st || !st.bones.size) return
  const validDt = dt > 0 && dt <= VELOCITY_RESET_DT
  for (const entry of st.bones.values()) {
    const q = entry.bone.quaternion
    if (entry.hasDisplayed && validDt) {
      // vel = log(q_now · q_prev⁻¹) / dt
      _tmpInv.copy(entry.displayed).invert()
      _tmpQ.copy(q).multiply(_tmpInv)
      quatToRotVec(_tmpQ, _tmpV)
      entry.vel.copy(_tmpV.divideScalar(dt))
      entry.velValid = true
    } else {
      entry.velValid = false
    }
    entry.displayed.copy(q)
    entry.hasDisplayed = true
  }
}

// ── 포즈 인지 전환 (모션 매칭 라이트) ────────────────────────────────

const SEEK_BONES = [
  ['上半身', 1.5],
  ['左腕', 1.0], ['右腕', 1.0],
  ['左ひじ', 0.7], ['右ひじ', 0.7],
  ['首', 0.5]
]
const SEEK_STEP = 0.1       // 샘플 간격 (s)
const SEEK_MAX_FRAC = 0.5   // 클립 앞 절반에서만 시작점 탐색
const SEEK_MIN_GAIN = 0.15  // 0프레임 대비 가중 각도합 이득이 이 미만이면 그냥 0

function quatAngle(qa, bx, by, bz, bw) {
  const dot = Math.abs(qa.x * bx + qa.y * by + qa.z * bz + qa.w * bw)
  return 2 * Math.acos(Math.min(1, dot))
}

/**
 * 새 클립에서 현재 자세와 가장 가까운 시작 시점 t*를 찾는다 (loop 클립 전용
 * — non-loop은 시작점을 미루면 finished가 조기 발화, Codex MUST-FIX).
 * 트랙이 없는 본은 탐색에서 제외; 이득이 작으면 0을 반환.
 */
export function findPoseAwareStart(clip, mesh) {
  const skeleton = mesh?.skeleton
  if (!skeleton || !clip?.duration) return 0
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]))
  const probes = []
  for (const [name, weight] of SEEK_BONES) {
    const bone = byName.get(name)
    if (!bone) continue
    const track = clip.tracks.find((tr) => tr.name === `.bones[${name}].quaternion`)
    if (!track) continue
    try {
      probes.push({ weight, q: bone.quaternion, interp: track.createInterpolant() })
    } catch {
      // 인터폴런트 생성 실패(빈 트랙 등) — 그 본만 탐색에서 뺀다
    }
  }
  if (probes.length < 3) return 0

  const tMax = clip.duration * SEEK_MAX_FRAC
  let bestT = 0
  let bestCost = Infinity
  let zeroCost = Infinity
  for (let t = 0; t <= tMax; t += SEEK_STEP) {
    let cost = 0
    for (const p of probes) {
      const r = p.interp.evaluate(t)
      cost += p.weight * quatAngle(p.q, r[0], r[1], r[2], r[3])
    }
    if (t === 0) zeroCost = cost
    if (cost < bestCost) {
      bestCost = cost
      bestT = t
    }
  }
  return zeroCost - bestCost >= SEEK_MIN_GAIN ? bestT : 0
}
