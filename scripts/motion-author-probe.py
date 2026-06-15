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
    "- frames 0..120. It MUST loop: keyframe at frame 120 equals frame 0. 2-4 keys per bone.\n"
    "Examples:\n"
    '손을 배 앞에 모음 -> {"bones":{"左腕":[[0,[-0.12,0.11,-0.64]],[120,[-0.12,0.11,-0.64]]],'
    '"右腕":[[0,[-0.12,-0.11,0.64]],[120,[-0.12,-0.11,0.64]]],'
    '"左ひじ":[[0,[0,-0.8,0]],[120,[0,-0.8,0]]],"右ひじ":[[0,[0,0.8,0]],[120,[0,0.8,0]]]}}\n'
    '느긋이 좌우로 흔들 -> {"bones":{"上半身":[[0,[0,0,0]],[30,[0,0,0.05]],[60,[0,0,0]],'
    '[90,[0,0,-0.05]],[120,[0,0,0]]]}}'
)


async def main():
    desc = sys.argv[1] if len(sys.argv) > 1 else "수줍게 양손을 배 앞에 모으고 몸을 살짝 비트는 차분한 idle"
    svc = ClaudeService()
    mode = await svc.ensure_mode("local")
    print(f"[probe] mode={mode}  desc={desc!r}", flush=True)
    if mode != "local":
        print("[probe] local 모드 아님 — 중단", flush=True)
        return
    raw = await svc._summarize_local(MOTION_SYSTEM, f"Motion: {desc}\nJSON:")
    print("=== RAW OUTPUT ===", flush=True)
    print(raw, flush=True)
    print("=== PARSE CHECK ===", flush=True)
    try:
        # JSON-in-prose 대비 첫 { ~ 마지막 } 추출
        s, e = raw.find("{"), raw.rfind("}")
        obj = json.loads(raw[s:e + 1]) if s >= 0 and e > s else None
        bones = (obj or {}).get("bones", obj)
        if not isinstance(bones, dict):
            print("parsed bones: FAIL")
            return
        print("parsed bones:", list(bones.keys()))
        # gen-vmd --from-json 형식으로 저장(베이크용).
        out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ai_motion_out.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"clips": {"idle/_ai_authored.vmd": bones}}, f, ensure_ascii=False, indent=2)
        print("wrote", out_path)
    except Exception as err:
        print("parse FAIL:", err)


if __name__ == "__main__":
    asyncio.run(main())
