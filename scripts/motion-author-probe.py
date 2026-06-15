# -*- coding: utf-8 -*-
"""
#2 AI 저작 절반 — 로컬 Qwen이 모션 키프레임(JSON)을 직접 써낼 수 있나 타진(feasibility).

7B가 PMX 본 회전 키프레임을 쓸 만하게 만드는지 확인하는 1회성 프로브. 출력이
gen-vmd --from-json 형식이면 그대로 베이크 가능. 안전규칙(팔꿈치 pi/2 회피 등,
직접 겪은 변형 함정)을 시스템 프롬프트에 박고, 검증된 클립을 few-shot으로 준다.

실행(anaconda python = torch/Qwen):
  cd backend && APIA_MAX_NEW_TOKENS=1024 python ../scripts/motion-author-probe.py "원하는 동작 설명"
"""
import asyncio
import json
import os
import sys

# backend/ 를 임포트 경로에 추가(어느 cwd에서 실행하든).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
# 주의: ClaudeService(torch/Qwen) import는 main()에서 지연 로드 — 순수함수
# (boost_amplitude/_metrics) 단위테스트는 torch 없는 셸에서도 이 모듈을 import만
# 하면 돌도록(test_motion_amplitude.py).

# ── 허용 본 + 진폭/안전 상수 (Codex 사전검토 반영) ───────────────────────────
L_ARM, R_ARM = "左腕", "右腕"
L_ELBOWS = {"左ひじ", "左ヒジ", "左肘"}  # 좌 팔꿈치 별칭(모델이 어느 표기를 써도)
R_ELBOWS = {"右ひじ", "右ヒジ", "右肘"}
ELBOW_BONES = L_ELBOWS | R_ELBOWS
DYNAMIC_MIN = 0.08    # 이 미만이면 "사실상 정지" — 재시도(노이즈 증폭 방지)
EXPRESSIVE_MIN = 0.25  # boost 후에도 이 peak 미달이면 거절("은은함")
TARGET_PEAK = 0.45    # boost 목표 peak 진폭(프롬프트 0.3~0.6 중앙)
MAX_SCALE = 6.0       # boost 배율 상한(0.08 -> 0.45 도 닿게, 폭주 방지)
ELBOW_MAX = 1.35      # |팔꿈치 y| 상한(1.57=pi/2 부근 전완 뒤집힘)
ARM_Z_MAX = 1.4       # 어깨 z 절대 상한

MOTION_SYSTEM = (
    "You author short LOOPING idle/gesture motions for an MMD/PMX anime character by "
    "writing BONE ROTATION keyframes. Output ONLY strict JSON, no prose, no markdown.\n"
    'Schema: {"bones": {"<bone>": [[frame, [rx, ry, rz]], ...], ...}}\n'
    "Rules:\n"
    "- Rotations are EULER radians relative to the REST pose. REST = all zeros [0,0,0] = natural\n"
    "  standing with arms hanging down. So frame 0 and frame 120 MUST be [0,0,0] for every bone.\n"
    "- Allowed bones ONLY: 上半身 (upper torso), 上半身2 (chest), 左腕/右腕 (L/R shoulder), "
    "左ひじ/右ひじ (L/R elbow). NEVER use head/neck/eye/leg/finger bones.\n"
    "- 左腕/右腕 z = raise the arm OUTWARD/UP. IMPORTANT SIGN: LEFT arm raises with z POSITIVE "
    "(+), RIGHT arm raises with z NEGATIVE (-). Bigger magnitude = higher (about +0.5 = arm out "
    "to the side, +0.9 = high). To raise BOTH arms: 左腕 z>0 and 右腕 z<0 (symmetric). "
    "x = forward/back swing. Do NOT use the wrong sign or the arm stays down.\n"
    "- 左ひじ/右ひじ y = bend the forearm in (LEFT elbow y NEGATIVE, RIGHT elbow y POSITIVE).\n"
    "- SAFETY: keep |elbow y| <= 1.35 (near 1.57=pi/2 the forearm flips/breaks). "
    "Do NOT combine a big shoulder raise (|z|>0.7) with a big elbow bend on the same arm.\n"
    "- frames 0..120 at 30fps (4초 루프). It is a MOVEMENT over time, NOT a frozen pose.\n"
    "- CRITICAL: the MIDDLE keyframes (30, 60, 90) MUST DIFFER from frame 0=[0,0,0] so the body\n"
    "  actually moves. Frame 0 and 120 are both [0,0,0] (seamless rest), 30/60/90 are the gesture.\n"
    "  If every keyframe of a bone is identical, that bone does nothing — avoid that.\n"
    "- Use 4-5 keys per moving bone (0, 30, 60, 90, 120).\n"
    "- Make the movement CLEARLY VISIBLE, not tiny. The MAIN moving bone should reach a PEAK "
    "single-axis change of about 0.4~0.6 rad from rest (e.g. 左腕 z 0->+0.5, 右ひじ y 0->+0.5). "
    "A subtle 0.1 motion reads as 'barely moving' and will be rejected. Be bold.\n"
    "- Build to the peak in the MIDDLE of the loop (around frame 60), then ease back — not a "
    "flat hold. The peak frame is the most extreme; 0 and 120 are the calm rest return.\n"
    "Examples (rest=[0,0,0] at 0/120, gesture peaks near frame 60, correct raise signs):\n"
    '양팔을 시원하게 위로 들었다 내림 -> {"bones":{"左腕":[[0,[0,0,0]],[30,[0,0,0.35]],[60,[0,0,0.6]],'
    '[90,[0,0,0.35]],[120,[0,0,0]]],"右腕":[[0,[0,0,0]],[30,[0,0,-0.35]],[60,[0,0,-0.6]],'
    '[90,[0,0,-0.35]],[120,[0,0,0]]]}}\n'
    '오른손을 크게 흔들어 인사 -> {"bones":{"右腕":[[0,[0,0,0]],[30,[0,0,-0.3]],[60,[0,0,-0.5]],'
    '[90,[0,0,-0.35]],[120,[0,0,0]]],"右ひじ":[[0,[0,0,0]],[30,[0,0.3,0]],[60,[0,0.6,0]],'
    '[90,[0,0.3,0]],[120,[0,0,0]]]}}\n'
    '생각하듯 한 손 들어 까딱 -> {"bones":{"右ひじ":[[0,[0,0,0]],[40,[0,0.5,0]],[80,[0,0.3,0]],[120,[0,0,0]]]}}'
)


DEFAULT_BATCH = [
    "수줍게 양손을 배 앞에 모으는 차분한 idle",
    "양팔을 천천히 들어올렸다 내리며 기지개 켜듯",
    "느긋이 좌우로 몸을 살짝 흔드는 idle",
]


async def gen_validated(svc, desc):
    """한 동작 묘사 → 저작 → (안전한 동적 클립이면) 진폭 정규화 → 재측정 → 채택.

    파이프라인 순서(Codex 사전검토): parse -> 동적 sanity -> boost -> 재측정 ->
    expressive+safe면 채택. 보수적인 7B 출력도 일단 boost로 키운 뒤 판정하므로,
    "움직이긴 하나 은은한" 클립이 버려지지 않고 또렷해진다. 정적(움직임 없음)만 재시도.
    반환: (bones|None, metrics|None, accepted:bool, info|None)."""
    best = None
    for attempt in range(2):
        nudge = "" if attempt == 0 else (
            "\n(이전 출력이 거의 움직이지 않았다. 중간 프레임(특히 60 근처)을 frame 0에서 "
            "0.4~0.5 rad 크게 벌려 또렷이 움직이게 하라.)")
        raw = await svc._summarize_local(MOTION_SYSTEM, f"Motion: {desc}\nJSON:" + nudge)
        b = _parse_bones(raw)
        if b is None:
            continue
        sanity = _metrics(b)
        if not sanity["dynamic"]:
            best = best or (b, sanity, False, {"reason": "static", "peak": round(sanity["peak"], 3)})
            continue  # 사실상 정지 — boost해도 노이즈만 키움 → 재시도
        boosted, scale = boost_amplitude(b)
        m = _metrics(boosted)
        info = {"origPeak": round(sanity["peak"], 3), "scale": round(scale, 2),
                "boostedPeak": round(m["peak"], 3), "where": m["where"], "bad": m["bad"]}
        accepted = m["expressive"] and m["safe"]
        best = (boosted, m, accepted, info)
        if accepted:
            return boosted, m, True, info
    if best is None:
        return None, None, False, None
    return best[0], best[1], best[2], best[3]


def boost_amplitude(bones, target=TARGET_PEAK):
    """결정적 진폭 정규화: 7B가 저작한 모양/타이밍은 보존하고 진폭만 목표까지 키운다.

    각 본을 frame0 대비 '델타'로 보고 단일 스칼라 배율로 곱한다(델타 비율 유지 =
    상대 모양 보존). frame0 델타=0이라 루프 끝(frame120)도 0 유지 → 이음새 보존.
    스케일 후 본별 안전 클램프(팔꿈치 |y|<=1.35, 어깨 z 좌[-1.4,0]/우[0,1.4]로 부호
    넘지 않게) 적용, 마지막에 루프 닫힘(마지막 키 = 첫 키)을 강제. (bones, scale) 반환."""
    peak, _ = _peak_delta(bones)
    scale = min(MAX_SCALE, max(1.0, target / peak)) if peak > 1e-6 else 1.0
    out = {}
    for bone, keys in bones.items():
        try:
            skeys = _norm_keys(keys)
        except Exception:
            out[bone] = keys  # 형식 오류면 원본 그대로(_metrics가 거름)
            continue
        if not skeys:
            continue
        base = list(_baseline(skeys))
        new_keys = []
        for f, rot in skeys:
            scaled = [base[a] + (rot[a] - base[a]) * scale for a in range(3)]
            new_keys.append([f, _clamp_bone(bone, scaled)])
        if len(new_keys) >= 2:  # 루프 닫힘 강제(클램프 후 미세 불일치도 차단)
            new_keys[-1][1] = list(new_keys[0][1])
        out[bone] = new_keys
    return out, scale


def _clamp_bone(bone, rot):
    """본별 안전 크기 클램프. rest=0 기준 + 런타임 hang 보정이라 어깨 z는 양방향 모두
    유효하다(왼팔 +z/오른팔 -z가 '들기'). 그래서 부호로 막지 않고 크기만 [-1.4,1.4]로
    제한(과한 overhead 방지). 변형(큰 어깨+큰 팔꿈치)은 _metrics 콤보검사가 잡는다.
    팔꿈치 y는 pi/2 부근 뒤집힘 방지로 |y|<=1.35."""
    r = [float(v) for v in rot]
    if bone in ELBOW_BONES:
        r[1] = max(-ELBOW_MAX, min(ELBOW_MAX, r[1]))
    elif bone in (L_ARM, R_ARM):
        r[2] = max(-ARM_Z_MAX, min(ARM_Z_MAX, r[2]))
    return r


def _norm_keys(keys):
    """[[frame,[rx,ry,rz]],...] → 프레임 오름차순 [(int frame,[float*3]),...]. 형식
    오류면 ValueError. 베이스라인/스케일이 항상 동일 정규형을 보게 한다."""
    out = sorted(((int(f), [float(v) for v in rot]) for f, rot in keys), key=lambda k: k[0])
    if any(len(rot) != 3 for _f, rot in out):
        raise ValueError("rot length != 3")
    return out


def _baseline(skeys):
    """루프 시작 자세 = frame 0 키(있으면), 없으면 최소 프레임. 'frame0 상대'를 명시 보장."""
    for f, rot in skeys:
        if f == 0:
            return rot
    return skeys[0][1]


def _peak_delta(bones):
    """움직이는 본 중 최대 단일축 변화량(frame0 대비)과 그 (본, 축). max-min이 아닌
    frame0-상대 델타 = '실제로 얼마나 자세가 벌어지나'를 잰다(Codex). 형식 오류 본은 건너뜀."""
    peak, where = 0.0, None
    for bone, keys in bones.items():
        try:
            skeys = _norm_keys(keys)
        except Exception:
            continue
        if not skeys:
            continue
        base = _baseline(skeys)
        for _f, rot in skeys:
            for a in range(3):
                d = abs(rot[a] - base[a])
                if d > peak:
                    peak, where = d, (bone, "xyz"[a])
    return peak, where


async def main():
    from services.claude_service import ClaudeService  # 지연 로드(torch/Qwen)
    descs = sys.argv[1:] or DEFAULT_BATCH
    svc = ClaudeService()
    mode = await svc.ensure_mode("local")
    print(f"[gen] mode={mode}  motions={len(descs)}", flush=True)
    if mode != "local":
        print("[gen] local 모드 아님 — 중단", flush=True)
        return
    clips, meta = {}, {}
    for i, desc in enumerate(descs):
        bones, m, ok, dbg = await gen_validated(svc, desc)
        tag = "OK" if ok else "SKIP"
        if m:
            line = (f"peak={m['peak']:.2f}@{m['where']} dynamic={m['dynamic']} "
                    f"expressive={m['expressive']} safe={m['safe']} bad={m['bad']}")
            if dbg and "scale" in dbg:
                line += f"  (boost {dbg['origPeak']}->{dbg['boostedPeak']} x{dbg['scale']})"
        else:
            line = "parse-fail"
        print(f"[{tag}] {desc!r} -> {line}", flush=True)
        if ok:
            name = f"ai_{i:02d}"
            clips[f"idle/{name}.vmd"] = bones
            meta[f"idle_{name}"] = {"desc": desc, "bones": list(bones),
                                    "peak": round(m["peak"], 3), **(dbg or {})}
    if not clips:
        print("[gen] 채택된 모션 없음", flush=True)
        return
    base = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base, "_ai_motion_batch.json"), "w", encoding="utf-8") as f:
        json.dump({"clips": clips, "_meta": meta}, f, ensure_ascii=False, indent=2)
    print(f"[gen] 채택 {len(clips)}개 -> _ai_motion_batch.json (베이크: gen-vmd --from-json)", flush=True)
    print(f"[gen] 후보 모션명: {list(meta)}", flush=True)


def _parse_bones(raw):
    try:
        s, e = raw.find("{"), raw.rfind("}")
        obj = json.loads(raw[s:e + 1]) if s >= 0 and e > s else None
        bones = (obj or {}).get("bones", obj)
        return bones if isinstance(bones, dict) else None
    except Exception:
        return None


def _metrics(bones):
    """동적성(peak 변화)·표현력(peak>=0.25)·안전 자동 판정. 안전(Codex 강화):
    pi/2 밴드뿐 아니라 |팔꿈치 y|>1.35 전부 거절 + 한쪽 큰 어깨들기(|z|>0.7)와 큰
    팔꿈치 굽힘(|y|>1.0)이 함께 나타나면(전완이 몸에 꽂힘) 거절."""
    bad = []
    good = {}
    for bone, keys in bones.items():
        try:
            good[bone] = _norm_keys(keys)
        except Exception:
            bad.append(f"{bone}:형식")
    peak, where = _peak_delta(good)
    for bone in (set(good) & ELBOW_BONES):
        if any(abs(rot[1]) > ELBOW_MAX for _f, rot in good[bone]):
            bad.append(f"{bone}:|y|>{ELBOW_MAX}")
    # 별칭 팔꿈치(ひじ/ヒジ/肘)도 한쪽으로 묶어 콤보 검사(Codex: 별칭 우회 차단).
    def _axis_max(bone_set, axis):
        return max((abs(rot[axis]) for b in bone_set for _f, rot in good.get(b, [])), default=0.0)
    for arm, elbows in ((L_ARM, L_ELBOWS), (R_ARM, R_ELBOWS)):
        az = _axis_max({arm}, 2)
        ey = _axis_max(elbows, 1)
        if az > 0.7 and ey > 1.0:
            bad.append(f"{arm}+elbow:lift{az:.2f}+bend{ey:.2f}")
    return {
        "peak": peak, "where": where,
        "dynamic": peak >= DYNAMIC_MIN,
        "expressive": peak >= EXPRESSIVE_MIN,
        "safe": len(bad) == 0,
        "bad": bad,
    }


if __name__ == "__main__":
    asyncio.run(main())
