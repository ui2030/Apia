# -*- coding: utf-8 -*-
"""
Apia 자체 VMD 모션 생성기 (자급자족 모션 수급 — 생성 기둥).

MMD/PMX 캐릭터(kisaki 등)의 talk/react 모션이 없어 절차적 폴백만 되던 갭을
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
  python scripts/gen-vmd.py --dump <file.vmd>   # 파싱 검증(헤더/본프레임 덤프)

상태/한계 (Codex 검토 반영, 2026-06-14):
  - 검증됨: 팔 제스처 talk 클립이 kisaki(PMX)에서 자연스럽게 재생(라이브 확인).
  - 머리 한계: main.js clipMask가 팔/몸통만 마스킹하고 머리·목·눈은 절차적
    시선 레이어가 항상 소유 → 끄덕임/갸웃 같은 머리 모션은 클립으로 못 줌
    (절차적 임펄스로 가야 함). 그래서 react_nod/surprised는 보류.
  - 모델불문 한계(미해결): 클립이 팔을 소유하면 절차적 팔처짐 보정이 꺼져
    클립이 처짐 베이스라인(∓0.74)을 직접 줘야 하는데, 이 값이 모델별 바인드
    포즈에 의존 → 다른 PMX에서 T자세 위험. 그래서 아래 클립은 **kisaki 튜닝
    잠정값**이고 .gitignore로 커밋 안 함. 올바른 길(차기 증분): clipMask를
    트랙 기반 granular로 바꿔 클립은 제스처 델타만 갖고 런타임이 모델별 팔처짐을
    클립 위에 합성 — 그러면 어떤 PMX에도 안전.
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
L_ARM, R_ARM = "左腕", "右腕"
L_ELBOW, R_ELBOW = "左ひじ", "右ひじ"

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


def write_vmd(path, frames):
    """frames: list of (bone_name, frame_int, (rx,ry,rz)). pos는 0 고정."""
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
        for _ in range(5):  # morph, camera, light, selfshadow, ik
            f.write(struct.pack("<I", 0))


def build_frames(clip):
    """clip: { bone: [(frame, (rx,ry,rz)), ...] } → flat frame list."""
    out = []
    for bone, keys in clip.items():
        for frame, rot in keys:
            out.append((bone, frame, rot))
    return out


# ── 클립 정의 (30fps, 회전 rad, 머리·상체 중심으로 축/크기 기준 확립) ──────
# 부호 방향은 kisaki에서 눈검증 후 조정. +X(頭)=앞으로 숙임(끄덕) 가정.

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
    # kisaki 튜닝값 — __boneWorldPos('lWrist')로 손목 y가 입 높이(~1.3)에 오게 조정.
    "idle/sip.vmd": {
        UPPER:   [(0, (0, 0, 0.02)), (80, (0, 0, 0.02))],
        L_ARM:   [(0, (0.48, -0.10, 0.90)), (40, (0.50, -0.10, 0.92)), (80, (0.48, -0.10, 0.90))],
        L_ELBOW: [(0, (0, -1.75, 0)), (40, (0, -1.78, 0)), (80, (0, -1.75, 0))],
        R_ELBOW: [(0, (0, -0.10, 0)), (80, (0, -0.10, 0))],
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
    # trailing section counts
    for label in ("morph", "camera", "light", "selfshadow", "ik"):
        if off + 4 <= len(data):
            (c,) = struct.unpack_from("<I", data, off)
            print(f"  [{label}] count={c}")
            off += 4
    print(f"total bytes: {len(data)}, parsed to: {off}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--dump":
        dump(sys.argv[2])
        return
    for rel, clip in CLIPS.items():
        path = os.path.join(VMD_DIR, rel.replace("/", os.sep))
        frames = build_frames(clip)
        write_vmd(path, frames)
        print(f"wrote {rel}  ({len(frames)} bone frames)")


if __name__ == "__main__":
    main()
