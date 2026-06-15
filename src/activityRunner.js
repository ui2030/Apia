// src/activityRunner.js
//
// J단계 거주형 비서 — 스마트 오브젝트 "활동" 시퀀서.
//
// 사물(furnitureLayout)이 선언한 activity 어포던스(ordered steps)를 받아 기존
// 원시 동작(walkTo + onArrive 체인, playMotion, showBubble, 수동 앉기)으로 한
// 단계씩 실행한다. 예: 커피머신 → 걸어가기 → 내리는 포즈 → 의자로 → 앉아 마시기
// → 성격별 정리. 물/책상/화장실 등 다음 사물도 같은 시퀀서를 재사용한다.
//
// 설계(Codex 검토 반영):
//  - first-class 러너 + abort 토큰. 중첩 onArrive 콜백의 무방비 사슬이 아니라,
//    매 step이 자기 토큰을 확인해 인터럽트되면 죽은 콜백이 no-op이 된다.
//  - isActive()로 스케줄러/클릭/채팅이 활동 중인지 확인(중복 시작·간섭 방지).
//  - abort(): 대기 콜백·타이머 취소, held 앉기 해제, 말풍선 비움 → 이후 호출자가
//    자유롭게 walkTo를 내릴 수 있다("호출 응답 = 최우선 인터럽트"의 토대).
//  - 어떤 step 콜백도 예외로 앱을 멈추지 않게 전부 safe-call로 감싼다.

function safe(fn, ...args) {
  try {
    if (typeof fn === 'function') return fn(...args)
  } catch (err) {
    console.error('[ACTIVITY_STEP_ERROR]', err)
  }
  return undefined
}

export function createActivityRunner(deps = {}) {
  const {
    walkTo, // ({x,z,sitOffset?,sitRotY?,seatHeight?,holdSit?,onArrive?}) => void
    releaseSit, // () => void  — held 앉기 해제 후 일어섬
    playMotion, // (motion) => void
    pickPose, // ({mood}) => motion  — 포즈/마시기 동작(슬라이스1은 기존 idle 재사용)
    showBubble, // (text, durationMs) => void
    getObjectById, // (id) => worldObject|null  — targetId 해석(좌표·좌석 데이터)
    getPersonality, // () => 'shy'|'active'|'calm'
    attachProp, // ({kind,hand}) => void — 손에 소품 들기
    detachProp, // () => void — 소품 내려놓기
    setReach, // (on) => void — 마시기/읽기 단계 동안 팔 IK 입-도달 on/off
    onFinish, // (reason, activity) => void — reason 'complete'|'abort'. 욕구는 complete만
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h)
  } = deps

  let token = 0 // start/abort마다 증가 — 이전 토큰의 step은 죽은 콜백
  let active = false
  let stepTimer = null
  let currentActivity = null

  function isActive() {
    return active
  }

  function clearStepTimer() {
    if (stepTimer != null) {
      clearTimer(stepTimer)
      stepTimer = null
    }
  }

  // 정상 종료 — 모든 step을 마쳤을 때. 욕구 충족은 이 경로(complete)에서만.
  function finish() {
    if (!active) return
    const done = currentActivity
    active = false
    currentActivity = null
    clearStepTimer()
    safe(detachProp) // 방어적 — 활동 데이터가 detach 스텝을 빠뜨려도 손에 남지 않게
    safe(onFinish, 'complete', done)
  }

  // 인터럽트/강제 중단 — 토큰을 올려 진행 중인 사슬을 죽이고, 호출자가 이후
  // 동작(walkTo 등)을 내릴 수 있게 held 앉기·소품·타이머·말풍선을 정리한다.
  // abort는 욕구를 채우지 않는다(reason 'abort').
  function abort() {
    if (!active) return
    const done = currentActivity
    token++
    clearStepTimer()
    safe(releaseSit)
    safe(detachProp) // 들고 있던 소품 내려놓기(Codex MUST-FIX: 모든 종료 경로)
    safe(showBubble, '', 0)
    active = false
    currentActivity = null
    safe(onFinish, 'abort', done)
  }

  function start(activity) {
    if (active) return false
    if (!activity || !Array.isArray(activity.steps) || activity.steps.length === 0) return false
    token++
    const myToken = token
    active = true
    currentActivity = activity
    runStep(activity.steps, 0, myToken)
    return true
  }

  function runStep(steps, i, myToken) {
    if (myToken !== token) return // 인터럽트됨
    if (i >= steps.length) {
      finish()
      return
    }

    const step = steps[i]
    const next = () => runStep(steps, i + 1, myToken)
    // 비동기 콜백(onArrive/타이머)이 인터럽트 후 도착하면 무시되도록 가드.
    const guarded = (fn) => () => {
      if (myToken === token) fn()
    }

    if (step.bubble) safe(showBubble, step.bubble, 2600)

    // 포즈 결정: step.motion이 지정되면 그 이름의 클립(예: 'talk_think'=손을 얼굴로
    // → 홀짝이는/읽는 모습), 없으면 성격 기반 engaged idle. 카테고리는 이름 접두사로.
    const poseFor = (s) => {
      if (s.motion) return { category: String(s.motion).split('_')[0] || 'idle', name: s.motion }
      return safe(pickPose, { mood: 'engaged' })
    }

    switch (step.kind) {
      case 'goto': {
        const obj = safe(getObjectById, step.targetId)
        if (!obj) {
          next()
          return
        }
        safe(walkTo, { x: obj.x, z: obj.z, onArrive: guarded(next) })
        return
      }

      case 'pose': {
        safe(playMotion, poseFor(step))
        if (step.reach) safe(setReach, true) // 서서 마시기 — 손을 입까지(IK)
        stepTimer = setTimer(guarded(() => { if (step.reach) safe(setReach, false); next() }), step.durationMs ?? 3000)
        return
      }

      case 'sit': {
        const obj = safe(getObjectById, step.targetId)
        if (!obj || !obj.sitOffset) {
          next()
          return
        }
        safe(walkTo, {
          x: obj.x,
          z: obj.z,
          sitOffset: obj.sitOffset,
          sitRotY: obj.sitRotY,
          seatHeight: obj.seatHeight,
          holdSit: true, // 마시는 동안 자동 기상 금지 — 러너가 dwell을 통제
          onArrive: guarded(() => {
            safe(playMotion, poseFor(step))
            if (step.reach) safe(setReach, true) // 앉아 마시기/읽기 — 손을 입/얼굴로(IK)
            stepTimer = setTimer(
              guarded(() => {
                if (step.reach) safe(setReach, false)
                safe(releaseSit) // 마시기 끝 → 일어섬
                next()
              }),
              step.durationMs ?? 8000
            )
          })
        })
        return
      }

      case 'prop': {
        // 손에 소품 들기/내려놓기 — 즉시 처리하고 다음 단계로.
        if (step.op === 'detach') safe(detachProp)
        else safe(attachProp, { kind: step.propKind, hand: step.hand || 'right' })
        next()
        return
      }

      case 'cleanup': {
        // 성격 분기: 부지런(active/calm)=싱크대로 가서 정리 / 느긋(shy)=그냥 마무리.
        // (슬라이스1은 컵 메시 없음 — 동선·말풍선으로 성격을 표현. 컵은 슬라이스2.)
        const personality = safe(getPersonality) || 'calm'
        const tidy = personality !== 'shy'
        const sink = tidy ? safe(getObjectById, 'sink') : null
        if (sink) {
          safe(showBubble, '컵은 정리하고~', 2400)
          safe(walkTo, { x: sink.x, z: sink.z, onArrive: guarded(next) })
        } else {
          safe(showBubble, '잘 마셨다.', 2200)
          stepTimer = setTimer(guarded(next), 800)
        }
        return
      }

      default:
        next()
    }
  }

  return {
    start,
    abort,
    isActive,
    // 최우선(호출 응답) 활동인지 — 일반 인터럽트(markInteraction 등)가 이걸
    // 건드리지 않게 한다(force일 때만 중단).
    isPriority() {
      return !!currentActivity?.priority
    },
    currentId() {
      return currentActivity?.id || null
    },
    get current() {
      return currentActivity
    }
  }
}

export default createActivityRunner
