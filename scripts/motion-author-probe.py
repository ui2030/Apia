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
from services.claude_service import ClaudeService

MOTION_SYSTEM = (
    "You author short LOOPING idle/gesture motions for an MMD/PMX anime character by "
    "writing BONE ROTATION keyframes. Output ONLY strict JSON, no prose, no markdown.\n"
    'Schema: {"bones": {"<bone>": [[frame, [rx, ry, rz]], ...], ...}}\n'
    "Rules:\n"
    "- Rotations are EULER radians relative to rest pose. Keep values small.\n"
    "- Allowed bones ONLY: 上半身 (upper torso), 上半身2 (chest), 左腕/右腕 (L/R shoulder), "
    "左ひじ/右ひじ (L/R elbow). NEVER use head/neck/eye/leg/finger bones.\n"
    "- 左腕/右腕: z raises/lowers the arm (left rest z ~ -0.7, right ~ +0.7; toward 0 = raised out). "
    "x = forward/back swing.\n"
    "- 左ひじ/右ひじ: y bends the forearm in (left negative, right positive).\n"
    "- SAFETY: keep |elbow y| <= 1.35 (near 1.57=pi/2 the forearm flips/breaks). "
    "Do NOT combine big shoulder lift (|z|>0.7) with a big elbow bend.\n"
    "- frames 0..120 at 30fps (4초 루프). It is a MOVEMENT over time, NOT a frozen pose.\n"
    "- CRITICAL: the MIDDLE keyframes (30, 60, 90) MUST DIFFER from frame 0 so the body actually\n"
    "  moves. Frame 0 and 120 are equal (seamless loop start/return), but 30/60/90 are different.\n"
    "  If every keyframe of a bone is identical, that bone does nothing — avoid that.\n"
    "- Use 4-5 keys per moving bone (0, 30, 60, 90, 120).\n"
    "- Make the movement CLEARLY VISIBLE, not tiny: a moving bone should change by about "
    "0.3~0.6 rad between frame 0 and its peak (e.g. shoulder z 0.7->0.3). Avoid changes under 0.1.\n"
    "Examples (note how middle frames differ from 0):\n"
    '느긋이 좌우로 흔들 -> {"bones":{"上半身":[[0,[0,0,0]],[30,[0,0,0.06]],[60,[0,0,0]],'
    '[90,[0,0,-0.06]],[120,[0,0,0]]]}}\n'
    '양팔을 천천히 들었다 내림 -> {"bones":{"左腕":[[0,[0,0,-0.7]],[30,[0,0,-0.4]],[60,[0,0,-0.2]],'
    '[90,[0,0,-0.45]],[120,[0,0,-0.7]]],"右腕":[[0,[0,0,0.7]],[30,[0,0,0.4]],[60,[0,0,0.2]],'
    '[90,[0,0,0.45]],[120,[0,0,0.7]]]}}\n'
    '생각하듯 한 손 까딱 -> {"bones":{"右ひじ":[[0,[0,0.2,0]],[40,[0,0.6,0]],[80,[0,0.4,0]],[120,[0,0.2,0]]]}}'
)


DEFAULT_BATCH = [
    "수줍게 양손을 배 앞에 모으는 차분한 idle",
    "양팔을 천천히 들어올렸다 내리며 기지개 켜듯",
    "느긋이 좌우로 몸을 살짝 흔드는 idle",
]


async def gen_validated(svc, desc):
    """한 동작 묘사 → 키프레임 저작 + 동적/안전 검증(정적이면 1회 재시도).
    반환: (bones|None, metrics|None, accepted:bool)."""
    best = None
    for attempt in range(2):
        nudge = "" if attempt == 0 else (
            "\n(이전 출력이 모든 프레임이 같아 움직임이 없었다. 중간 프레임 30/60/90을 "
            "frame 0과 다르게 만들어 실제로 움직이게 하라.)")
        raw = await svc._summarize_local(MOTION_SYSTEM, f"Motion: {desc}\nJSON:" + nudge)
        b = _parse_bones(raw)
        if b is None:
            continue
        m = _metrics(b)
        best = (b, m)
        if m["dynamic"] and m["safe"]:
            return b, m, True
    if best is None:
        return None, None, False
    return best[0], best[1], False  # 마지막 후보(부적합) — 참고용


async def main():
    descs = sys.argv[1:] or DEFAULT_BATCH
    svc = ClaudeService()
    mode = await svc.ensure_mode("local")
    print(f"[gen] mode={mode}  motions={len(descs)}", flush=True)
    if mode != "local":
        print("[gen] local 모드 아님 — 중단", flush=True)
        return
    clips, meta = {}, {}
    for i, desc in enumerate(descs):
        bones, m, ok = await gen_validated(svc, desc)
        tag = "OK" if ok else "SKIP"
        info = (f"dynamic={m['dynamic']} maxVar={m['maxVar']:.2f} safe={m['safe']} bad={m['bad']}"
                if m else "parse-fail")
        print(f"[{tag}] {desc!r} -> {info}", flush=True)
        if ok:
            name = f"ai_{i:02d}"
            clips[f"idle/{name}.vmd"] = bones
            meta[f"idle_{name}"] = {"desc": desc, "bones": list(bones), "maxVar": round(m["maxVar"], 3)}
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
    """동적성(키프레임이 변하나)·안전(팔꿈치 pi/2 회피) 자동 판정."""
    elbows = {"左ひじ", "右ひじ", "左ヒジ", "右ヒジ", "左肘", "右肘"}
    max_var = 0.0
    bad = []
    for bone, keys in bones.items():
        try:
            axes = list(zip(*[[float(v) for v in rot] for _f, rot in keys]))
        except Exception:
            bad.append(f"{bone}:형식")
            continue
        for ax in axes:
            max_var = max(max_var, max(ax) - min(ax))
        if bone in elbows:
            for _f, rot in keys:
                if 1.45 <= abs(float(rot[1])) <= 1.70:
                    bad.append(f"{bone}:pi/2")
    return {"dynamic": max_var >= 0.08, "maxVar": max_var, "safe": len(bad) == 0, "bad": bad}


if __name__ == "__main__":
    asyncio.run(main())
