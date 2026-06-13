# -*- coding: utf-8 -*-
"""
음성 복제 통합 스모크 — GPU·네트워크 필요한 수동 검증 도구 (CI 미포함).

흐름: ① Edge 인준(남성) 장문 합성 → 참조 음성 ② Edge 선히(여성) 한 문장
③ seed-vc 로드(첫 회 체크포인트 다운로드) ④ 선히 음성을 인준 음색으로 변환
⑤ f0(기본 주파수) 중앙값으로 "변환음이 참조 쪽으로 이동했는가" 정량 단언.

실행: python scripts/voice-clone-smoke.py  (Apia 루트에서)
산출물: test-results/voice-clone-smoke/{reference,source,converted}.wav
"""
import asyncio
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # cp949 콘솔 대비

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

OUT_DIR = ROOT / "test-results" / "voice-clone-smoke"
OUT_DIR.mkdir(parents=True, exist_ok=True)

REF_TEXT = (
    "별빛이 흐르는 다리를 건너, 바람 부는 갈대숲을 지나. "
    "오늘도 수많은 이야기가 우리 곁을 스쳐 지나갑니다. "
    "어떤 날은 기쁘고, 어떤 날은 조금 지치기도 하지만, "
    "그 모든 순간이 모여 우리의 하루가 됩니다. "
    "잠시 숨을 고르고, 따뜻한 차 한 잔과 함께 쉬어 가세요."
)
SRC_TEXT = "안녕하세요! 저는 아피아예요. 이게 제 새 목소리랍니다."


async def edge_synth(text: str, voice: str) -> bytes:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice)
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


def median_f0(samples, sr) -> float:
    import librosa
    import numpy as np

    f0, voiced, _ = librosa.pyin(
        samples.astype("float32"), sr=sr,
        fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"),
    )
    voiced_f0 = f0[voiced & ~np.isnan(f0)]
    return float(np.median(voiced_f0)) if voiced_f0.size else 0.0


async def main():
    from services import voice_clone_service as clone

    print("available:", clone.is_available())
    assert clone.is_available(), "seed-vc unavailable"

    print("[1/5] reference (InJoon)...")
    ref_mp3 = await edge_synth(REF_TEXT, "ko-KR-InJoonNeural")
    ref_samples, ref_sr = clone.decode_audio(ref_mp3, "audio/mpeg")
    ref_path = OUT_DIR / "reference.wav"
    ref_path.write_bytes(clone.encode_wav(ref_samples, ref_sr))
    print(f"  {len(ref_samples)/ref_sr:.1f}s @ {ref_sr}")

    print("[2/5] source (SunHi)...")
    src_mp3 = await edge_synth(SRC_TEXT, "ko-KR-SunHiNeural")
    src_samples, src_sr = clone.decode_audio(src_mp3, "audio/mpeg")
    (OUT_DIR / "source.wav").write_bytes(clone.encode_wav(src_samples, src_sr))

    print("[3/5] loading seed-vc (first run downloads checkpoints)...")
    t0 = time.time()
    await clone.ensure_loaded()
    print(f"  loaded in {time.time()-t0:.0f}s")

    print("[4/5] converting...")
    t0 = time.time()
    out_wav = await clone.convert(src_mp3, "audio/mpeg", ref_path)
    convert_sec = time.time() - t0
    (OUT_DIR / "converted.wav").write_bytes(out_wav)
    out_samples, out_sr = clone.decode_audio(out_wav, "audio/wav")
    out_dur = len(out_samples) / out_sr
    src_dur = len(src_samples) / src_sr
    print(f"  {convert_sec:.1f}s for {src_dur:.1f}s utterance → output {out_dur:.1f}s @ {out_sr}")

    print("[5/5] f0 analysis...")
    f0_src = median_f0(src_samples, src_sr)
    f0_ref = median_f0(ref_samples, ref_sr)
    f0_out = median_f0(out_samples, out_sr)
    print(f"  f0 median — source(SunHi): {f0_src:.0f}Hz, reference(InJoon): {f0_ref:.0f}Hz, converted: {f0_out:.0f}Hz")

    dur_ok = abs(out_dur - src_dur) < max(1.0, src_dur * 0.25)
    shifted = abs(f0_out - f0_ref) < abs(f0_out - f0_src)
    nonsilent = float(abs(out_samples).mean()) > 1e-3
    print(f"\ndurOk={dur_ok} shiftedTowardRef={shifted} nonSilent={nonsilent} convertSec={convert_sec:.1f}")
    if not (dur_ok and shifted and nonsilent):
        print("VOICE CLONE SMOKE FAILED")
        sys.exit(1)
    print("VOICE CLONE SMOKE PASSED")


asyncio.run(main())
