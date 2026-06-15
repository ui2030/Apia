# -*- coding: utf-8 -*-
"""motion-author-probe.py 순수함수(진폭 정규화·검증) 결정적 단위테스트.

torch/Qwen 불필요 — ClaudeService import는 probe의 main()에서 지연 로드라 이
모듈만 import하면 된다. 실행: python scripts/test_motion_amplitude.py
"""
import importlib.util
import os

_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "motion-author-probe.py")
_spec = importlib.util.spec_from_file_location("motion_probe", _path)
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def peak_of(bones):
    return P._peak_delta(bones)[0]


def test_small_clip_boosted_to_target():
    # 은은한 클립(peak 0.1) -> 목표(0.45) 근처로 키워짐, 모양(상대 비율) 보존.
    bones = {"右ひじ": [[0, [0, 0.0, 0]], [60, [0, 0.10, 0]], [120, [0, 0.0, 0]]]}
    boosted, scale = P.boost_amplitude(bones)
    assert approx(scale, 0.45 / 0.10, 1e-3), scale
    assert approx(peak_of(boosted), 0.45, 1e-3), peak_of(boosted)
    assert P._metrics(boosted)["expressive"]


def test_large_clip_unchanged():
    # 이미 큰 클립(peak 0.5 > target) -> 배율 1.0, 줄이지 않음.
    bones = {"右ひじ": [[0, [0, 0.0, 0]], [60, [0, 0.50, 0]], [120, [0, 0.0, 0]]]}
    boosted, scale = P.boost_amplitude(bones)
    assert approx(scale, 1.0), scale
    assert approx(peak_of(boosted), 0.50, 1e-6), peak_of(boosted)


def test_elbow_clamp():
    # boost가 팔꿈치를 pi/2 너머로 밀어도 |y|<=1.35로 클램프.
    bones = {"右ひじ": [[0, [0, 0.0, 0]], [60, [0, 0.40, 0]], [120, [0, 0.0, 0]]]}
    boosted, _ = P.boost_amplitude(bones)  # 0.40 -> x(0.45/0.40)=1.125 = 0.45 (안전)
    # 더 공격적으로: 입력 peak를 작게 해 큰 배율 유도
    bones2 = {"右ひじ": [[0, [0, 0.0, 0]], [60, [0, 0.30, 0]], [120, [0, 0.0, 0]],
                        [30, [0, 1.60, 0]]]}  # peak 1.60 -> scale 1.0, 클램프로 1.35
    boosted2, _ = P.boost_amplitude(bones2)
    ys = [abs(rot[1]) for _f, rot in boosted2["右ひじ"]]
    assert max(ys) <= P.ELBOW_MAX + 1e-9, max(ys)
    assert not P._metrics({"右ひじ": bones2["右ひじ"]})["safe"]  # 원본은 unsafe


def test_arm_z_symmetric_magnitude_clamp():
    # rest=0 + hang 보정이라 어깨 z는 양방향 모두 유효(왼팔 +z/오른팔 -z=들기).
    # 부호로 막지 않고 크기만 [-1.4,1.4]로 제한 — 들기 방향이 살아있어야 한다.
    # 왼팔 +z(들기)는 보존되고, 과한 값만 1.4로 잘림.
    bones = {"左腕": [[0, [0, 0, 0]], [60, [0, 0, 0.5]], [120, [0, 0, 0]]]}
    boosted, _ = P.boost_amplitude(bones)
    assert max(rot[2] for _f, rot in boosted["左腕"]) > 0.0  # 들기 방향 안 막힘
    assert max(abs(rot[2]) for _f, rot in boosted["左腕"]) <= P.ARM_Z_MAX + 1e-9
    # 오른팔 -z(들기)도 보존, 과한 음수는 -1.4로 잘림.
    big = {"右腕": [[0, [0, 0, 0]], [30, [0, 0, -3.0]], [60, [0, 0, -0.5]], [120, [0, 0, 0]]]}
    boosted_r, _ = P.boost_amplitude(big)
    zs = [rot[2] for _f, rot in boosted_r["右腕"]]
    assert min(zs) < 0.0  # 들기(음수) 방향 살아있음
    assert min(zs) >= -P.ARM_Z_MAX - 1e-9  # 크기 클램프
    # 왼팔 양수 과대값도 +1.4로 포화(대칭).
    big_l = {"左腕": [[0, [0, 0, 0]], [30, [0, 0, 3.0]], [60, [0, 0, 0.5]], [120, [0, 0, 0]]]}
    boosted_l, _ = P.boost_amplitude(big_l)
    assert max(rot[2] for _f, rot in boosted_l["左腕"]) <= P.ARM_Z_MAX + 1e-9


def test_unsafe_shoulder_elbow_combo():
    # 큰 어깨들기(|z|>0.7) + 큰 팔꿈치 굽힘(|y|>1.0) = unsafe.
    bones = {"右腕": [[0, [0, 0, 0.9]], [60, [0, 0, 0.9]]],
             "右ひじ": [[0, [0, 1.2, 0]], [60, [0, 1.2, 0]]]}
    assert not P._metrics(bones)["safe"]
    # 어깨만 크고 팔꿈치 작으면 안전.
    ok = {"右腕": [[0, [0, 0, 0.9]], [60, [0, 0, 0.9]]],
          "右ひじ": [[0, [0, 0.2, 0]], [60, [0, 0.2, 0]]]}
    assert P._metrics(ok)["safe"]


def test_alias_elbow_combo_not_bypassed():
    # 별칭 팔꿈치 표기(ヒジ/肘)로도 큰어깨+큰팔꿈치 콤보가 unsafe로 잡혀야 함.
    for elbow in ("右ヒジ", "右肘"):
        bones = {"右腕": [[0, [0, 0, 0.9]], [60, [0, 0, 0.9]]],
                 elbow: [[0, [0, 1.2, 0]], [60, [0, 1.2, 0]]]}
        assert not P._metrics(bones)["safe"], elbow


def test_baseline_uses_frame0_not_min():
    # frame 0이 없으면 최소 프레임을 베이스라인으로 — 정렬 순서와 무관히 동작.
    bones = {"右ひじ": [[60, [0, 0.5, 0]], [30, [0, 0.0, 0]], [120, [0, 0.0, 0]]]}
    peak, where = P._peak_delta(bones)
    assert approx(peak, 0.5, 1e-6), peak  # base=frame30(0.0) 기준 0.5


def test_baseline_prefers_frame0_over_min():
    # frame 0 키가 있으면 정렬 순서·다른 작은 프레임과 무관히 frame0을 베이스라인으로.
    bones = {"右ひじ": [[10, [0, 0.4, 0]], [0, [0, 0.1, 0]], [60, [0, 0.6, 0]]]}
    peak, _ = P._peak_delta(bones)
    assert approx(peak, 0.5, 1e-6), peak  # base=frame0(0.1) -> 0.6-0.1=0.5 (min프레임10 아님)


def test_malformed_no_crash():
    # 형식 깨진 본이 섞여도 크래시 없이 safe=False.
    bones = {"右ひじ": "garbage", "右腕": [[0, [0, 0, 0.3]], [60, [0, 0, 0.2]]]}
    m = P._metrics(bones)
    assert not m["safe"]
    P.boost_amplitude(bones)  # 크래시 안 함


def test_loop_closure():
    # boost/clamp 후 마지막 키 == 첫 키(루프 이음새).
    bones = {"右腕": [[0, [0, 0, 0.7]], [30, [0, 0, 0.35]], [60, [0.1, 0.2, 0.2]],
                     [90, [0, 0, 0.4]], [120, [0, 0, 0.65]]]}
    boosted, _ = P.boost_amplitude(bones)
    keys = boosted["右腕"]
    assert keys[0][1] == keys[-1][1], (keys[0], keys[-1])


def test_static_not_dynamic():
    # 모든 프레임 동일 -> dynamic False(재시도 대상).
    bones = {"右ひじ": [[0, [0, 0.1, 0]], [60, [0, 0.1, 0]], [120, [0, 0.1, 0]]]}
    assert not P._metrics(bones)["dynamic"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for t in tests:
        t()
        print(f"  PASS {t.__name__}")
        passed += 1
    print(f"\n{passed}/{len(tests)} passed")
