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
    # 설명하듯 말하기: 클립이 팔을 소유하면 절차적 팔처짐(-0.743/+0.743)이
    # 꺼지므로, 자연스러운 처짐을 클립이 직접 줘야 한다(HANG). 그 위에 작은
    # 제스처. 상체 살짝 sway. loop (0==마지막). (머리는 절차적 소유라 생략)
    "talk/explain.vmd": {
        UPPER:  [(0, (0, 0, 0)), (30, (0, 0.04, 0)), (60, (0, 0, 0))],
        L_ARM:  [(0, (0, 0, -0.74)), (20, (0, 0, -0.60)), (40, (0, 0, -0.70)), (60, (0, 0, -0.74))],
        R_ARM:  [(0, (0, 0, 0.74)), (20, (0, 0, 0.66)), (40, (0, 0, 0.55)), (60, (0, 0, 0.74))],
        L_ELBOW: [(0, (0, 0, 0)), (20, (0, 0.20, 0)), (40, (0, 0.08, 0)), (60, (0, 0, 0))],
        R_ELBOW: [(0, (0, 0, 0)), (20, (0, -0.12, 0)), (40, (0, -0.26, 0)), (60, (0, 0, 0))],
    },
    # 생각하기: 한 손(왼팔)을 가슴/턱 쪽으로 올린 채 가만히 — 팔만으로 표현
    # (머리 갸웃은 절차적 소유라 클립에서 못 줌). 오른팔은 처짐 유지. loop.
    "talk/think.vmd": {
        UPPER:   [(0, (0, 0, 0.02)), (80, (0, 0, 0.02))],
        # 왼팔: 처짐(-0.74)에서 약간 들어올림(-0.45) + 앞으로(x), 팔꿈치 크게 굽혀
        # 손이 가슴/턱 쪽으로. 미세 흔들림.
        L_ARM:   [(0, (0.25, 0, -0.48)), (40, (0.28, 0, -0.44)), (80, (0.25, 0, -0.48))],
        L_ELBOW: [(0, (0, -1.25, 0)), (40, (0, -1.30, 0)), (80, (0, -1.25, 0))],
        # 오른팔: 자연 처짐 유지(약한 흔들림).
        R_ARM:   [(0, (0, 0, 0.74)), (40, (0, 0, 0.70)), (80, (0, 0, 0.74))],
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
