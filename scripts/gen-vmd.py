# -*- coding: utf-8 -*-
"""
Apia 자체 VMD 모션 생성기 (자급자족 모션 수급 — 생성 기둥).

MMD/PMX 캐릭터(테스트 모델 등)의 talk/react 모션이 없어 절차적 폴백만 되던 갭을
메운다. 외부 다운로드/서비스 없이 PMX 표준 본 회전 키프레임을 직접 저작해
원본 .vmd를 굽는다(라이선스 자유 → 커밋·배포 가능).

설계: 클립은 본별 (frame, eulerXYZ) 키프레임 리스트. 생성기가 euler→quat 변환
후 VMD 바이너리로 직렬화. 회전은 본 로컬 좌표(MMD 좌수계). position은 0 고정
(playMMDAnimation의 root/IK position 제거 로직과 충돌 안 함, talk/react는 회전만).

VMD 포맷 (리틀엔디안, Codex 사전검토 반영):
  - 헤더 30B 시그니처 + 20B 모델명(shift-jis 바이트절단+null pad)
  - 본프레임 N: 15B 본명(shift-jis 바이트절단) + uint32 frame + float32x3 pos
    + float32x4 quat(x,y,z,w 정규화) + 64B 보간
  - 후행 섹션(morph/camera/light/selfshadow/ik) 카운트 0으로 기록(파서 호환)

사용:
  python scripts/gen-vmd.py            # 모든 클립을 매니페스트 경로로 생성
  python scripts/gen-vmd.py --dump <file.vmd>       # 파싱 검증(헤더/본·모프프레임 덤프)
  python scripts/gen-vmd.py --from-json <file.json> # 외부(AI/도구) 키프레임 JSON→VMD
      # JSON v1: {"clips":{"idle/foo.vmd":{"左腕":[[frame,[rx,ry,rz]],...]}}}
      # JSON v2: {"clips":{"idle/foo.vmd":{"bones":{"左腕":[...]},
      #           "morphs":{"にっこり":[[frame,weight],...]}}}} — 표정 동시 저작

상태 (전신 연기 v2, 2026-07-03 — granular clipMask 이후):
  - 머리 가능해짐: clipMask가 트랙 기반 granular라 클립이 頭/首를 키프레임하면
    그 role은 applyPose가 건너뛰고 클립이 소유한다(구 "머리 불가" 제약 해소).
    단 소유 중엔 절차적 시선 추적·임펄스가 머리에 안 닿으므로 **머리를 키하는
    클립은 짧은 non-loop 연기에만** 쓴다(루프 talk이 머리를 쥐면 시선이 죽음).
  - 팔처짐: 클립은 제스처 델타만 갖고 런타임 applyClipArmHangCorrection이
    모델별 팔처짐을 클립 위에 합성(A-2) — 어떤 PMX에도 안전.
  - 무게이동: センター/腰 position은 로더가 스트립하므로 회전(下半身 롤)로 표현.
    클립 재생 중엔 MMD 발 IK가 살아 있어(무클립시엔 OFF) 발이 심긴다. 단
    applyPose가 helper.update 뒤에 돌므로, 다리 role을 클립이 소유하지 않으면
    절차 rest 쓰기가 IK 결과를 덮는다 → 下半身을 키하는 클립은 좌우 足/ひざ에
    **0회전 키를 놓아 소유권만 이전**한다(마스킹 목적, 값은 IK가 결정).
  - 표정: 모프 트랙을 함께 구우면 재생 중 표정/립싱크 런타임이 그 모프를
    양보한다(2026-07-03 엔진 수정). 모프명은 모델 사전과 직매칭(별칭 해석 없음)
    — 없는 이름은 조용히 무시되므로 EMOTION_PRESETS 표준명 위주로 쓴다.
"""
import math
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VMD_DIR = os.path.join(ROOT, "src", "assets", "motions", "vmd")
MODEL_NAME = "Apia"  # VMD 모델명 필드(임의 — 본 이름만 맞으면 어떤 PMX에도 적용)

# PMX 표준 본 이름 (poseRig MMD_CANDIDATES와 일치)
HEAD = "頭"
NECK = "首"
UPPER = "上半身"
UPPER2 = "上半身2"
LOWER = "下半身"
L_SHOULDER, R_SHOULDER = "左肩", "右肩"
L_ARM, R_ARM = "左腕", "右腕"
L_ELBOW, R_ELBOW = "左ひじ", "右ひじ"
L_LEG, R_LEG = "左足", "右足"
L_KNEE, R_KNEE = "左ひざ", "右ひざ"

# MMD 기본 본 보간(준선형, MMD가 기본 키프레임에 쓰는 대각 패턴). 64바이트.
DEFAULT_INTERP = bytes([
    20, 20, 0, 0, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 0,
    20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 0, 0,
    20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 0, 0, 0,
    20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107, 0, 0, 0, 0,
])


def euler_to_quat(rx, ry, rz):
    """XYZ 내인 오일러(rad) → 정규화 쿼터니언 (x, y, z, w)."""
    cx, sx = math.cos(rx / 2), math.sin(rx / 2)
    cy, sy = math.cos(ry / 2), math.sin(ry / 2)
    cz, sz = math.cos(rz / 2), math.sin(rz / 2)
    x = sx * cy * cz + cx * sy * sz
    y = cx * sy * cz - sx * cy * sz
    z = cx * cy * sz + sx * sy * cz
    w = cx * cy * cz - sx * sy * sz
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    return (x / n, y / n, z / n, w / n)


def sjis_fixed(s, length):
    b = s.encode("shift_jis", errors="replace")[:length]
    return b + b"\x00" * (length - len(b))


def write_vmd(path, frames, morph_frames=()):
    """frames: list of (bone_name, frame_int, (rx,ry,rz)). pos는 0 고정.
    morph_frames: list of (morph_name, frame_int, weight) — 표정 트랙(v2).
    섹션 순서(VMD 규격, Codex 확인): 본 → 모프 → camera/light/selfshadow/ik 카운트."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"Vocaloid Motion Data 0002\x00\x00\x00\x00\x00")  # 30B
        f.write(sjis_fixed(MODEL_NAME, 20))
        f.write(struct.pack("<I", len(frames)))
        for bone, frame, (rx, ry, rz) in frames:
            q = euler_to_quat(rx, ry, rz)
            f.write(sjis_fixed(bone, 15))
            f.write(struct.pack("<I", int(frame)))
            f.write(struct.pack("<3f", 0.0, 0.0, 0.0))
            f.write(struct.pack("<4f", *q))
            f.write(DEFAULT_INTERP)
        f.write(struct.pack("<I", len(morph_frames)))  # 모프 프레임: 15B명 + frame + weight
        for name, frame, weight in morph_frames:
            f.write(sjis_fixed(name, 15))
            f.write(struct.pack("<I", int(frame)))
            f.write(struct.pack("<f", float(weight)))
        for _ in range(4):  # camera, light, selfshadow, ik
            f.write(struct.pack("<I", 0))


def normalize_clip(clip):
    """클립 스키마 정규화(Codex MUST-FIX) → (bones, morphs).
    v2: {"bones": {...}, "morphs": {...}} / v1(legacy): 평평한 {본: 키들}.
    v1 판정을 키 이름으로 하면 'bones'라는 본명과 충돌하므로, dict에 bones/morphs
    키가 하나라도 있으면 v2로 본다(본명은 일본어라 충돌 실현 없음)."""
    if isinstance(clip, dict) and ("bones" in clip or "morphs" in clip):
        return clip.get("bones", {}) or {}, clip.get("morphs", {}) or {}
    return clip, {}


def build_frames(clip):
    """clip: { bone: [(frame, (rx,ry,rz)), ...] } → flat frame list."""
    out = []
    for bone, keys in clip.items():
        for frame, rot in keys:
            out.append((bone, frame, rot))
    return out


def build_morph_frames(morphs):
    """morphs: { name: [(frame, weight), ...] } → flat (name, frame, weight)."""
    out = []
    for name, keys in morphs.items():
        for frame, weight in keys:
            out.append((name, int(frame), float(weight)))
    return out


# ── 클립 정의 (30fps, 회전 rad, 머리·상체 중심으로 축/크기 기준 확립) ──────
# 부호 방향은 테스트 모델에서 눈검증 후 조정. +X(頭)=앞으로 숙임(끄덕) 가정.

# 주의 — 아키텍처 제약: clipMask가 팔/몸통/다리만 마스킹하고 머리·목·눈은
# 절차적 시선 레이어가 항상 소유한다(src/poseRig.js + main.js clipMask). 따라서
# 끄덕임·고개 갸웃 같은 *머리 기반* react/talk는 클립으로 주면 절차적이 덮어써
# 안 보인다. 그런 모션은 절차적 임펄스(poseRig에 nod/surprise 레이어)로 가야
# 한다 — 별도 증분. 여기 talk 클립은 팔만으로 표현해 클립으로 동작한다.
# (react_nod / react_surprised 는 머리 중심이라 일단 보류.)
CLIPS = {
    # A-2 이후: 클립은 *제스처 델타*만 갖는다(처짐 베이스라인 제거). 런타임이
    # 모델별 팔처짐(applyClipArmHangCorrection)을 이 델타 위에 합성하므로
    # 어떤 PMX에도 안전하다. (머리는 절차적 소유라 생략)
    # 설명하듯 말하기: 팔을 살짝 앞/밖으로 들고 팔꿈치 굽혀 제스처. loop.
    "talk/explain.vmd": {
        UPPER:  [(0, (0, 0, 0)), (30, (0, 0.04, 0)), (60, (0, 0, 0))],
        L_ARM:  [(0, (0, 0, 0)), (20, (0.05, 0, 0.13)), (40, (0.02, 0, 0.05)), (60, (0, 0, 0))],
        R_ARM:  [(0, (0, 0, 0)), (20, (0.05, 0, -0.07)), (40, (0.08, 0, -0.15)), (60, (0, 0, 0))],
        L_ELBOW: [(0, (0, 0, 0)), (20, (0, 0.22, 0)), (40, (0, 0.10, 0)), (60, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (20, (0, -0.14, 0)), (40, (0, -0.30, 0)), (60, (0, 0, 0))],
    },
    # 생각하기: 왼손을 가슴/턱 쪽으로 올린 채 가만히 — 델타로 표현(처짐 위 합성).
    # 왼팔을 처짐에서 들어올리는 +z 델타 + 앞으로(x) + 팔꿈치 크게 굽힘. loop.
    # (머리 갸웃은 절차적 소유라 클립에서 생략.)
    "talk/think.vmd": {
        UPPER:   [(0, (0, 0, 0.02)), (80, (0, 0, 0.02))],
        L_ARM:   [(0, (0.28, 0, 0.30)), (40, (0.30, 0, 0.34)), (80, (0.28, 0, 0.30))],
        L_ELBOW: [(0, (0, -1.25, 0)), (40, (0, -1.30, 0)), (80, (0, -1.25, 0))],
        R_ARM:   [(0, (0, 0, 0)), (40, (0.02, 0, -0.02)), (80, (0, 0, 0))],
        R_ELBOW: [(0, (0, -0.10, 0)), (80, (0, -0.10, 0))],
    },
    # 부드럽게 말하기: 차분한 작은 한손 제스처(팔꿈치 중심), 비대칭. loop.
    "talk/soft.vmd": {
        L_ELBOW: [(0, (0, 0, 0)), (24, (0, 0.16, 0)), (48, (0, 0.06, 0)), (70, (0, 0, 0))],
        L_ARM:   [(0, (0, 0, 0)), (24, (0.03, 0, 0.04)), (70, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (35, (0, -0.07, 0)), (70, (0, 0, 0))],
    },
    # 즐겁게 말하기: 양팔을 더 열고 팔꿈치 크게, 빠른 템포(짧은 루프). loop.
    "talk/happy.vmd": {
        UPPER:   [(0, (0, 0, 0)), (24, (0, 0.05, 0)), (48, (0, 0, 0))],
        L_ARM:   [(0, (0, 0, 0)), (16, (0.10, 0, 0.20)), (32, (0.06, 0, 0.10)), (48, (0, 0, 0))],
        R_ARM:   [(0, (0, 0, 0)), (16, (0.08, 0, -0.12)), (32, (0.12, 0, -0.22)), (48, (0, 0, 0))],
        L_ELBOW: [(0, (0, 0, 0)), (16, (0, 0.34, 0)), (32, (0, 0.16, 0)), (48, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (16, (0, -0.22, 0)), (32, (0, -0.40, 0)), (48, (0, 0, 0))],
    },
    # 담담하게 말하기: 거의 정지, 아주 가끔 미세 팔꿈치. 느린 루프. loop.
    "talk/neutral.vmd": {
        L_ELBOW: [(0, (0, 0, 0)), (45, (0, 0.10, 0)), (90, (0, 0, 0))],
        R_ARM:   [(0, (0, 0, 0)), (60, (0.02, 0, -0.04)), (90, (0, 0, 0))],
    },
    # 부드럽게 설명: explain의 절제판. loop.
    "talk/explain_soft.vmd": {
        L_ARM:   [(0, (0, 0, 0)), (28, (0.03, 0, 0.07)), (56, (0.01, 0, 0.02)), (80, (0, 0, 0))],
        R_ARM:   [(0, (0, 0, 0)), (28, (0.03, 0, -0.04)), (56, (0.05, 0, -0.08)), (80, (0, 0, 0))],
        L_ELBOW: [(0, (0, 0, 0)), (28, (0, 0.12, 0)), (80, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (28, (0, -0.08, 0)), (56, (0, -0.16, 0)), (80, (0, 0, 0))],
    },
    # 기뻐하는 리액션: 양팔을 살짝 열어 들어올렸다 내림. non-loop(빠름).
    # 머리 끄덕(happy bob)은 트리거에서 nod 임펄스로 추가.
    "react/happy.vmd": {
        L_ARM:   [(0, (0, 0, 0)), (8, (0.16, 0, 0.30)), (16, (0.08, 0, 0.14)), (26, (0, 0, 0))],
        R_ARM:   [(0, (0, 0, 0)), (8, (0.16, 0, -0.22)), (16, (0.08, 0, -0.10)), (26, (0, 0, 0))],
        L_ELBOW: [(0, (0, 0, 0)), (8, (0, 0.40, 0)), (16, (0, 0.18, 0)), (26, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (8, (0, -0.30, 0)), (16, (0, -0.14, 0)), (26, (0, 0, 0))],
    },
    # 수줍은 리액션: 왼손을 얼굴/가슴 쪽으로 올리고 몸 살짝 움츠림. non-loop.
    "react/shy.vmd": {
        L_ARM:   [(0, (0, 0, 0)), (10, (0.30, 0, 0.34)), (24, (0.30, 0, 0.34)), (40, (0.05, 0, 0.06))],
        L_ELBOW: [(0, (0, 0, 0)), (10, (0, -1.10, 0)), (24, (0, -1.15, 0)), (40, (0, -0.20, 0))],
        R_ARM:   [(0, (0, 0, 0)), (12, (0.06, 0, 0.05)), (40, (0, 0, 0))],
        UPPER:   [(0, (0, 0, 0)), (12, (0.04, 0, 0.04)), (40, (0, 0, 0))],
    },

    # ── idle 포즈 클립 (팔만 키 → 호흡/시선은 절차적으로 위에 계속 합성) ──
    # 루프 이음새가 안 튀게 frame 0 = 유지 포즈(rest 아님). 진입은 clip fadeIn이
    # 현재 자세→포즈로 부드럽게. 미세 흔들림으로 정지 느낌을 줄임. 모델불문.
    # 팔짱: 양 전완을 가슴 앞에서 교차. 팔처짐 베이스라인(∓0.74)을 이기고 전완을
    # 양손 허리(akimbo). 기존 "가슴 교차"는 어깨 큰 들기(z=0.78)+팔꿈치 90°(1.58,
    # π/2 경계) 조합이 전완을 몸에 꽂아 기형으로 보였다(사용자 보고). 검증된
    # hand_on_hip 값(팔꿈치 1.35, 어깨 작게)을 양팔 대칭으로 써 깨끗한 자세로 교체.
    "idle/arms_crossed.vmd": {
        L_ARM:   [(0, (-0.05, 0, -0.18)), (60, (-0.05, 0, -0.19)), (120, (-0.05, 0, -0.18))],
        L_ELBOW: [(0, (0, -1.35, 0)), (60, (0, -1.33, 0)), (120, (0, -1.35, 0))],
        R_ARM:   [(0, (-0.05, 0, 0.18)), (60, (-0.05, 0, 0.19)), (120, (-0.05, 0, 0.18))],
        R_ELBOW: [(0, (0, 1.35, 0)), (60, (0, 1.33, 0)), (120, (0, 1.35, 0))],
    },
    # 한 손 허리: 오른손을 허리에.
    "idle/hand_on_hip.vmd": {
        R_ARM:   [(0, (-0.05, 0, 0.18)), (120, (-0.05, 0, 0.18))],
        R_ELBOW: [(0, (0, 1.35, 0)), (60, (0, 1.33, 0)), (120, (0, 1.35, 0))],
        L_ARM:   [(0, (0, 0, 0)), (60, (0.03, 0, 0.03)), (120, (0, 0, 0))],
    },
    # 두 손 앞으로 모음(낮게).
    "idle/hands_clasped.vmd": {
        L_ARM:   [(0, (0.16, 0, 0.10)), (110, (0.16, 0, 0.10))],
        L_ELBOW: [(0, (0, -0.80, 0)), (55, (0, -0.78, 0)), (110, (0, -0.80, 0))],
        R_ARM:   [(0, (0.16, 0, -0.10)), (110, (0.16, 0, -0.10))],
        R_ELBOW: [(0, (0, 0.80, 0)), (55, (0, 0.78, 0)), (110, (0, 0.80, 0))],
    },
    # 느슨하게(손 살짝 앞).
    "idle/relaxed.vmd": {
        L_ARM:   [(0, (0.09, 0, 0.04)), (110, (0.09, 0, 0.04))],
        L_ELBOW: [(0, (0, -0.42, 0)), (55, (0, -0.38, 0)), (110, (0, -0.42, 0))],
        R_ELBOW: [(0, (0, 0.40, 0)), (55, (0, 0.36, 0)), (110, (0, 0.40, 0))],
    },
    # 생각(손을 가슴 앞으로) — 깨끗한 "팔짱 비슷한 생각" 포즈. 손을 *턱*까지 올리려면
    # 이 rig의 팔꿈치(Y굽힘)가 전완을 위로 못 접어(컵-입 도달과 같은 한계) FK로 불가 →
    # 팔 IK 타깃팅(maybeReachPropToMouth처럼 턱 목표) 필요, 별도 기능으로 보류.
    "idle/ponder.vmd": {
        L_ARM:   [(0, (0.30, 0, 0.32)), (120, (0.30, 0, 0.32))],
        L_ELBOW: [(0, (0, -1.28, 0)), (60, (0, -1.25, 0)), (120, (0, -1.28, 0))],
        R_ELBOW: [(0, (0, 0.08, 0)), (120, (0, 0.08, 0))],
    },
    # 관심 있게 살짝 앞으로 기울임(engaged) — 몸통만(머리는 절차 시선 소유라 클립 불가),
    # 팔은 아주 작게. 안전 범위(어깨 큰 들기·π/2 팔꿈치 회피).
    "idle/lean_in.vmd": {
        UPPER:   [(0, (0.12, 0, 0)), (60, (0.13, 0, 0)), (120, (0.12, 0, 0))],
        UPPER2:  [(0, (0.06, 0, 0)), (60, (0.07, 0, 0)), (120, (0.06, 0, 0))],
        L_ARM:   [(0, (0.10, 0, 0)), (120, (0.10, 0, 0))],
        R_ARM:   [(0, (0.10, 0, 0)), (120, (0.10, 0, 0))],
    },
    # 느긋한 좌우 무게이동(ambient) — 몸통 좌우 롤을 한 주기 천천히. 팔 작게 따라감.
    "idle/sway_relax.vmd": {
        UPPER:   [(0, (0, 0, 0)), (30, (0, 0, 0.05)), (60, (0, 0, 0)), (90, (0, 0, -0.05)), (120, (0, 0, 0))],
        UPPER2:  [(0, (0, 0, 0)), (30, (0, 0, 0.03)), (60, (0, 0, 0)), (90, (0, 0, -0.03)), (120, (0, 0, 0))],
        L_ARM:   [(0, (0, 0, 0)), (30, (0, 0, 0.04)), (60, (0, 0, 0)), (90, (0, 0, -0.04)), (120, (0, 0, 0))],
        R_ARM:   [(0, (0, 0, 0)), (30, (0, 0, 0.04)), (60, (0, 0, 0)), (90, (0, 0, -0.04)), (120, (0, 0, 0))],
    },
    # 기지개(양팔 바깥으로 들었다 내림) — AI 저작 산출물. **컨벤션 수정(2026-06-16)**:
    # 클립은 rest=0 기준 + 런타임 hang 보정이라, 팔을 들려면 왼팔 z 양수/오른팔 z 음수다
    # (이전엔 rest를 ∓0.7로 잘못 잡아 동작이 hang 근처로 수렴해 거의 안 보였음 — 다각도
    # 진단렌더로 규명). 이제 rest(0)에서 바깥 +0.6/-0.6으로 또렷이 들었다 복귀.
    "idle/stretch_arms.vmd": {
        L_ARM: [(0, (0, 0, 0)), (30, (0, 0, 0.35)), (60, (0, 0, 0.6)), (90, (0, 0, 0.35)), (120, (0, 0, 0))],
        R_ARM: [(0, (0, 0, 0)), (30, (0, 0, -0.35)), (60, (0, 0, -0.6)), (90, (0, 0, -0.35)), (120, (0, 0, 0))],
    },
    # 한 손 들어 인사(비대칭) — AI 저작. 컨벤션 수정: 오른팔 z 음수=들기, 오른 팔꿈치
    # y 양수=굽힘. rest(0)에서 오른팔 들고 팔꿈치 까딱여 흔든다.
    "idle/wave.vmd": {
        R_ARM:   [(0, (0, 0, 0)), (30, (0, 0, -0.4)), (60, (0, 0, -0.5)), (90, (0, 0, -0.4)), (120, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (30, (0, 0.3, 0)), (60, (0, 0.55, 0)), (90, (0, 0.3, 0)), (120, (0, 0, 0))],
    },
    # 뒷짐(양손 허리 뒤쪽으로).
    "idle/hands_back.vmd": {
        L_ARM:   [(0, (-0.18, 0, 0.06)), (120, (-0.18, 0, 0.06))],
        L_ELBOW: [(0, (0, -0.55, 0)), (120, (0, -0.55, 0))],
        R_ARM:   [(0, (-0.18, 0, -0.06)), (120, (-0.18, 0, -0.06))],
        R_ELBOW: [(0, (0, 0.55, 0)), (120, (0, 0.55, 0))],
    },
    # 홀짝(컵을 입가로) — 왼손을 입까지 올린다. 팔처짐 베이스라인(∓0.74)을 크게
    # 넘는 lift(z)로 위팔을 들고, 팔꿈치를 강하게 굽혀 전완을 입으로. 컵/책 소품을
    # 든 손이 얼굴 근처로 오게 하는 전용 포즈(activityRunner drink/read 단계).
    # 테스트 모델 튜닝값 — __boneWorldPos('lWrist')로 손목 y가 입 높이(~1.3)에 오게 조정.
    "idle/sip.vmd": {
        UPPER:   [(0, (0, 0, 0.02)), (80, (0, 0, 0.02))],
        L_ARM:   [(0, (0.48, -0.10, 0.90)), (40, (0.50, -0.10, 0.92)), (80, (0.48, -0.10, 0.90))],
        L_ELBOW: [(0, (0, -1.75, 0)), (40, (0, -1.78, 0)), (80, (0, -1.75, 0))],
        R_ELBOW: [(0, (0, -0.10, 0)), (80, (0, -0.10, 0))],
    },

    # ── 전신 연기 v2 (2026-07-03) — 머리·목·어깨·표정 모프까지 쓰는 첫 저작 클립.
    # granular clipMask 덕에 頭/首 키가 유효해짐(위 docstring). 셋 다 non-loop이고
    # frame 0 = 마지막 frame = 중립이라 진입 fadeIn/종료 release fade가 안 튄다.
    # 웃음(킥킥): 고개를 살짝 젖혔다 두 번 까딱이며 어깨 들썩, 미소 모프 동기.
    # 성격 intensity가 진폭을 눌러주므로 shy에서도 과하지 않다.
    "react/giggle.vmd": {
        "bones": {
            HEAD:  [(0, (0, 0, 0)), (8, (-0.06, 0, 0.02)), (16, (0.10, 0, 0.03)),
                    (24, (0.02, 0, 0.02)), (32, (0.12, 0, 0.04)), (44, (0.03, 0, 0.01)),
                    (62, (0, 0, 0)), (78, (0, 0, 0))],
            NECK:  [(0, (0, 0, 0)), (16, (0.04, 0, 0.01)), (32, (0.05, 0, 0.01)),
                    (62, (0, 0, 0)), (78, (0, 0, 0))],
            L_SHOULDER: [(0, (0, 0, 0)), (12, (0, 0, 0.08)), (20, (0, 0, 0.03)),
                         (28, (0, 0, 0.09)), (42, (0, 0, 0.02)), (62, (0, 0, 0))],
            R_SHOULDER: [(0, (0, 0, 0)), (14, (0, 0, -0.07)), (22, (0, 0, -0.02)),
                         (30, (0, 0, -0.08)), (44, (0, 0, -0.02)), (62, (0, 0, 0))],
            UPPER: [(0, (0, 0, 0)), (16, (0.05, 0, 0.01)), (24, (0.02, 0, 0)),
                    (32, (0.06, 0, -0.01)), (48, (0.01, 0, 0)), (70, (0, 0, 0))],
            L_ARM: [(0, (0, 0, 0)), (14, (0.06, 0, 0.10)), (40, (0.03, 0, 0.05)), (70, (0, 0, 0))],
            R_ARM: [(0, (0, 0, 0)), (14, (0.06, 0, -0.08)), (40, (0.03, 0, -0.04)), (70, (0, 0, 0))],
            L_ELBOW: [(0, (0, 0, 0)), (14, (0, 0.30, 0)), (40, (0, 0.14, 0)), (70, (0, 0, 0))],
            R_ELBOW: [(0, (0, 0, 0)), (16, (0, -0.24, 0)), (42, (0, -0.12, 0)), (70, (0, 0, 0))],
        },
        "morphs": {
            "にっこり": [(0, 0.0), (10, 0.65), (30, 0.8), (55, 0.4), (78, 0.0)],
            "笑い":     [(0, 0.0), (12, 0.30), (40, 0.35), (78, 0.0)],
        },
    },
    # 한숨: 들숨(어깨·가슴 들리고 고개 살짝 위) → 뚝 떨어뜨리며 고개 숙임 → 회복.
    # 낙하 구간(f34→46)이 들숨(f0→20)보다 빨라 "후—" 하는 리듬이 생긴다.
    "react/sigh.vmd": {
        "bones": {
            L_SHOULDER: [(0, (0, 0, 0)), (20, (0, 0, 0.10)), (34, (0, 0, 0.10)),
                         (44, (0, 0, -0.04)), (70, (0, 0, -0.02)), (96, (0, 0, 0))],
            R_SHOULDER: [(0, (0, 0, 0)), (20, (0, 0, -0.10)), (34, (0, 0, -0.10)),
                         (44, (0, 0, 0.04)), (70, (0, 0, 0.02)), (96, (0, 0, 0))],
            UPPER: [(0, (0, 0, 0)), (20, (-0.05, 0, 0)), (34, (-0.05, 0, 0)),
                    (46, (0.09, 0, 0)), (72, (0.05, 0, 0)), (96, (0, 0, 0))],
            UPPER2: [(0, (0, 0, 0)), (20, (-0.02, 0, 0)), (46, (0.04, 0, 0)),
                     (72, (0.02, 0, 0)), (96, (0, 0, 0))],
            HEAD:  [(0, (0, 0, 0)), (20, (-0.08, 0, 0)), (34, (-0.06, 0, 0)),
                    (48, (0.16, 0, 0)), (74, (0.08, 0, 0)), (96, (0, 0, 0))],
            NECK:  [(0, (0, 0, 0)), (20, (-0.03, 0, 0)), (48, (0.06, 0, 0)),
                    (74, (0.03, 0, 0)), (96, (0, 0, 0))],
            L_ARM: [(0, (0, 0, 0)), (20, (-0.03, 0, 0.05)), (46, (0.04, 0, -0.02)), (96, (0, 0, 0))],
            R_ARM: [(0, (0, 0, 0)), (20, (-0.03, 0, -0.05)), (46, (0.04, 0, 0.02)), (96, (0, 0, 0))],
        },
        "morphs": {
            "困る": [(0, 0.0), (30, 0.25), (48, 0.6), (80, 0.3), (96, 0.0)],
        },
    },
    # 호기심(갸웃): 머리 롤틸트+살짝 돌아봄, 상체 따라 기울고 下半身 롤로 무게이동.
    # 다리 0회전 키 = 소유권 이전용(값은 발 IK가 결정 — docstring 무게이동 항목).
    # 손은 검증된 hands_clasped 값으로 앞에 모아 "귀 기울이는" 실루엣.
    "idle/curious.vmd": {
        "bones": {
            HEAD:  [(0, (0, 0, 0)), (25, (0.02, 0.08, 0.14)), (60, (0.03, 0.10, 0.18)),
                    (95, (0.02, 0.06, 0.10)), (120, (0, 0, 0))],
            NECK:  [(0, (0, 0, 0)), (25, (0.01, 0.03, 0.06)), (60, (0.01, 0.04, 0.07)),
                    (95, (0.01, 0.02, 0.04)), (120, (0, 0, 0))],
            UPPER: [(0, (0, 0, 0)), (30, (0.02, 0, 0.04)), (60, (0.03, 0, 0.05)),
                    (120, (0, 0, 0))],
            UPPER2: [(0, (0, 0, 0)), (30, (0.01, 0, 0.02)), (60, (0.01, 0, 0.03)),
                     (120, (0, 0, 0))],
            LOWER: [(0, (0, 0, 0)), (30, (0, 0, 0.03)), (60, (0, 0, 0.04)),
                    (95, (0, 0, 0.02)), (120, (0, 0, 0))],
            L_LEG:  [(0, (0, 0, 0)), (120, (0, 0, 0))],
            R_LEG:  [(0, (0, 0, 0)), (120, (0, 0, 0))],
            L_KNEE: [(0, (0, 0, 0)), (120, (0, 0, 0))],
            R_KNEE: [(0, (0, 0, 0)), (120, (0, 0, 0))],
            # 손 앞모음: x 전방성분만으론 부족 — z 들기(하강 상쇄)가 작으면 팔꿈치
            # 굽힘이 전완을 등 뒤로 보낸다(x0.16/z0.10, x0.27/z0.07 모두 3각도
            # 스크린샷에서 뒷짐 실루엣으로 실측). 가슴 앞 도달이 검증된 ponder
            # (0.30,0,0.32)+팔꿈치 -1.28의 80% 스케일을 양팔 대칭으로 사용.
            L_ARM:   [(0, (0, 0, 0)), (20, (0.24, 0, 0.26)), (100, (0.24, 0, 0.26)), (120, (0, 0, 0))],
            L_ELBOW: [(0, (0, 0, 0)), (20, (0, -1.02, 0)), (100, (0, -1.02, 0)), (120, (0, 0, 0))],
            R_ARM:   [(0, (0, 0, 0)), (20, (0.24, 0, -0.26)), (100, (0.24, 0, -0.26)), (120, (0, 0, 0))],
            R_ELBOW: [(0, (0, 0, 0)), (20, (0, 1.02, 0)), (100, (0, 1.02, 0)), (120, (0, 0, 0))],
        },
        "morphs": {
            "眉上移動": [(0, 0.0), (25, 0.35), (90, 0.3), (120, 0.0)],
            "にこり":   [(0, 0.0), (30, 0.25), (95, 0.2), (120, 0.0)],
        },
    },
}


def dump(path):
    with open(path, "rb") as f:
        data = f.read()
    sig = data[:30].split(b"\x00")[0].decode("ascii", "replace")
    model = data[30:50].split(b"\x00")[0].decode("shift_jis", "replace")
    (count,) = struct.unpack_from("<I", data, 50)
    print(f"signature: {sig!r}")
    print(f"model: {model!r}")
    print(f"bone frames: {count}")
    off = 54
    by_bone = {}
    for _ in range(count):
        name = data[off:off + 15].split(b"\x00")[0].decode("shift_jis", "replace")
        (frame,) = struct.unpack_from("<I", data, off + 15)
        qx, qy, qz, qw = struct.unpack_from("<4f", data, off + 15 + 4 + 12)
        norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        by_bone.setdefault(name, []).append((frame, round(norm, 4)))
        off += 15 + 4 + 12 + 16 + 64
    for name, keys in by_bone.items():
        frames = sorted(k[0] for k in keys)
        norms = {k[1] for k in keys}
        print(f"  {name}: {len(keys)} keys, frames {frames}, |q| {sorted(norms)}")
    # 모프 섹션(본 바로 다음, 프레임당 23B = 15B명 + uint32 + float32)
    if off + 4 <= len(data):
        (mcount,) = struct.unpack_from("<I", data, off)
        off += 4
        print(f"  [morph] count={mcount}")
        by_morph = {}
        for _ in range(mcount):
            mname = data[off:off + 15].split(b"\x00")[0].decode("shift_jis", "replace")
            (mframe,) = struct.unpack_from("<I", data, off + 15)
            (mweight,) = struct.unpack_from("<f", data, off + 19)
            by_morph.setdefault(mname, []).append((mframe, round(mweight, 3)))
            off += 23
        for mname, keys in by_morph.items():
            print(f"    {mname}: {sorted(keys)}")
    # trailing section counts
    for label in ("camera", "light", "selfshadow", "ik"):
        if off + 4 <= len(data):
            (c,) = struct.unpack_from("<I", data, off)
            print(f"  [{label}] count={c}")
            off += 4
    print(f"total bytes: {len(data)}, parsed to: {off}")


# #2 AI 모션 파이프라인 입구 — 외부(LLM/도구)가 만든 키프레임 JSON을 VMD로 굽는다.
# 무거운 SMPL→PMX 리타겟 없이, "AI가 PMX 본 회전 키프레임을 직접 저작 → 여기서
# 베이크 → 자동 등록"으로 모션을 자급한다([[apia-motion-supply-fit]]).
# JSON 형식: {"clips": {"idle/foo.vmd": {"左腕": [[frame,[rx,ry,rz]], ...], ...}, ...}}
# euler(rad), build_frames/write_vmd가 리스트도 그대로 처리.
ELBOW_BONES = {"左ひじ", "右ひじ", "左ヒジ", "右ヒジ", "左肘", "右肘"}
ARM_BONES = {"左腕", "右腕"}

def validate_clip(rel, bones, morphs=None):
    """변형 함정 경고(직접 겪은 것): 팔꿈치 |회전|이 π/2 부근이면 짐벌/뒤집힘 위험,
    어깨 큰 들기(|z|>0.7)+팔꿈치 큰 굽힘 조합은 전완이 몸에 꽂힐 수 있음. 모프
    weight는 [0,1] 밖이면 경고. 하드 실패는 아니고 경고만 — 저작자가 눈검증
    다각도로 확인하도록. (頭/首 키는 granular clipMask 이후 정상 — 경고 대상 아님.)"""
    warns = []
    arm_lift = {}
    for bone, keys in bones.items():
        for _f, rot in keys:
            mx = max(abs(float(v)) for v in rot)
            if bone in ELBOW_BONES and 1.45 <= mx <= 1.70:
                warns.append(f"{bone} 회전 {mx:.2f} (pi/2 부근) - 짐벌/뒤집힘 위험(값 조정 권장)")
            if bone in ARM_BONES:
                arm_lift[bone] = max(arm_lift.get(bone, 0), abs(float(rot[2])))
    for bone in ARM_BONES & set(bones):
        if arm_lift.get(bone, 0) > 0.7:
            warns.append(f"{bone} 어깨 들기 z>0.7 - 큰 팔꿈치 굽힘과 겹치면 전완이 몸에 꽂힐 수 있음(다각도 검수)")
    for name, keys in (morphs or {}).items():
        for _f, w in keys:
            if not (0.0 <= float(w) <= 1.0):
                warns.append(f"모프 {name} weight {w} - [0,1] 밖(모델별 과변형 위험)")
    for w in dict.fromkeys(warns):
        print(f"  [warn] {rel}: {w}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--dump":
        dump(sys.argv[2])
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--from-json":
        import json
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            data = json.load(f)
        clips = data.get("clips", data) if isinstance(data, dict) else {}
        for rel, clip in clips.items():
            bones, morphs = normalize_clip(clip)
            validate_clip(rel, bones, morphs)
            path = os.path.join(VMD_DIR, rel.replace("/", os.sep))
            frames = build_frames({b: [(int(fr), tuple(float(v) for v in rot)) for fr, rot in keys]
                                   for b, keys in bones.items()})
            mframes = build_morph_frames({m: [(int(fr), float(w)) for fr, w in keys]
                                          for m, keys in morphs.items()})
            write_vmd(path, frames, mframes)
            print(f"wrote {rel}  ({len(frames)} bone + {len(mframes)} morph frames) [from json]")
        return
    for rel, clip in CLIPS.items():
        bones, morphs = normalize_clip(clip)
        validate_clip(rel, bones, morphs)
        path = os.path.join(VMD_DIR, rel.replace("/", os.sep))
        frames = build_frames(bones)
        mframes = build_morph_frames(morphs)
        write_vmd(path, frames, mframes)
        print(f"wrote {rel}  ({len(frames)} bone + {len(mframes)} morph frames)")


if __name__ == "__main__":
    main()
