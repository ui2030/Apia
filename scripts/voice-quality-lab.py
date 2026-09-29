"""
음성 품질 실험대 — 귀로 고를 수밖에 없는 값들을 파일로 뽑아 놓는다.

무엇을 만드는가 (전부 wav, 한 폴더에):
  01_prosody_*         같은 문장을 감정 버킷별 운율로 (발주서 12 §A-5)
  02_sanitize_*        이모지·마크다운을 넣은 문장의 정화 전/후 (§A 검수)
  03_clone_steps_*     복제 음성: 디퓨전 스텝별 (§B-2 ②) — 시간도 재서 표로
  04_clone_ref_*       복제 음성: 참조 전처리 유무 (§B-2 ①)
  05_clone_prosody_*   복제 경로에서 운율이 살아남는지 (§A-4)

쓰는 법:
    cd backend && .venv/Scripts/python.exe ../scripts/voice-quality-lab.py [출력폴더]

참조 음성은 사용자 업로드본이 없으면 다른 Edge 목소리로 합성해 쓴다 —
음색 변환이 실제로 도는지/음질이 어떤지 보는 데는 충분하다.
"""
import asyncio
import os
import sys
import time
from pathlib import Path

# 콘솔이 cp949면 한글·이모지 print에서 죽는다 — 출력만 UTF-8로 갈아탄다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\ui2030\Desktop\apia-voice-lab")

SENTENCE = "오늘 하루 어땠어요? 저는 창밖 보면서 계속 기다리고 있었어요."
DIRTY = "**정말** 반가워요 😊🎉 ㅋㅋㅋ 자세한 건 https://example.com/apia 에서 봐요!"
REFERENCE_VOICE = "ko-KR-InJoonNeural"  # 기본(선히)과 다른 목소리 = 변환 대상 음색
STEPS = [10, 25, 50]


def _sf():
    import soundfile as sf
    return sf


# ── 참조 전처리 (렌더러 settings.html preprocessReferencePcm의 측정용 미러) ──
# 배포 경로는 렌더러 쪽 하나다. 여기 있는 건 "같은 알고리즘을 파이썬에서 돌려
# 음질을 비교"하기 위한 실험용 사본 — 값이 갈리면 렌더러가 정답이다.
FRAME = 512
SILENCE_MULT = 1.6
PEAK = 0.95


def preprocess_reference(samples):
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).copy()
    if x.size == 0:
        return x
    pad = (-x.size) % FRAME
    frames = np.pad(x, (0, pad)).reshape(-1, FRAME)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    threshold = (float(np.sort(rms)[int(len(rms) * 0.1)]) if len(rms) else 0.0) * SILENCE_MULT

    loud = np.where(rms > threshold)[0]
    first, last = (int(loud[0]), int(loud[-1])) if loud.size else (0, len(rms) - 1)
    out = frames[first:last + 1].reshape(-1)[: x.size - first * FRAME].copy()
    peak = float(np.abs(out).max()) if out.size else 0.0
    if peak > 0.001:
        out *= PEAK / peak
    return out


async def edge_wav(text, voice, rate="+0%", pitch="+0Hz"):
    """Edge-TTS → wav bytes (mp3를 앱과 같은 디코더로 wav로 내린다)."""
    from services import voice_clone_service as clone
    from services.tts_service import TTSService

    svc = TTSService.__new__(TTSService)
    svc._edge_available = True
    mp3 = await svc._synthesize_edge(text, voice, (rate, pitch))
    samples, sr = clone.decode_audio(mp3, "audio/mpeg")
    return samples, sr


def write(path, samples, sr):
    path.parent.mkdir(parents=True, exist_ok=True)
    _sf().write(str(path), samples, sr, format="WAV", subtype="PCM_16")
    print(f"  wrote {path.name}  ({len(samples) / sr:.1f}s)")
    return path


async def main():
    from services import speech_text as st
    from services import voice_clone_service as clone

    OUT.mkdir(parents=True, exist_ok=True)
    rows = []

    # ── 01 운율 버킷 ────────────────────────────────────────────────────
    print("[01] 운율 버킷")
    for bucket in ("neutral", "happy", "sad", "surprised"):
        rate, pitch = st.prosody_for(bucket)
        samples, sr = await edge_wav(SENTENCE, "ko-KR-SunHiNeural", rate, pitch)
        write(OUT / f"01_prosody_{bucket}_{rate}_{pitch}.wav", samples, sr)

    # ── 02 정화 전/후 ───────────────────────────────────────────────────
    print("[02] 정화 전/후")
    clean, rate, pitch = st.speech_plan(DIRTY)
    print(f"  raw   : {DIRTY.encode('ascii', 'backslashreplace').decode()}")
    print(f"  clean : {clean}   (rate={rate} pitch={pitch})")
    samples, sr = await edge_wav(DIRTY, "ko-KR-SunHiNeural")           # 정화 전
    write(OUT / "02_sanitize_before.wav", samples, sr)
    samples, sr = await edge_wav(clean, "ko-KR-SunHiNeural", rate, pitch)  # 정화 후
    write(OUT / "02_sanitize_after.wav", samples, sr)

    if not clone.is_available():
        print("[skip] seed-vc 사용 불가 — 복제 실험은 건너뜁니다")
        return

    # ── 참조 음성 준비 (원본 / 전처리) ──────────────────────────────────
    print("[ref] 참조 음성 준비")
    ref_text = "안녕하세요. 저는 여기서 계속 기다리고 있을게요. 편하게 말 걸어 주세요."
    ref_samples, ref_sr = await edge_wav(ref_text, REFERENCE_VOICE)
    # 실제 사용자 녹음을 흉내 내려고 약한 정적 잡음 + 앞뒤 무음을 붙인다.
    import numpy as np
    rng = np.random.default_rng(7)
    noisy = np.concatenate([
        np.zeros(int(ref_sr * 0.8), dtype=np.float32),
        (ref_samples * 0.25).astype(np.float32),
        np.zeros(int(ref_sr * 0.8), dtype=np.float32),
    ])
    noisy = (noisy + rng.normal(0, 0.004, noisy.shape).astype(np.float32)).astype(np.float32)
    ref_raw = write(OUT / "00_reference_raw.wav", noisy, ref_sr)
    ref_prep = write(OUT / "00_reference_preprocessed.wav", preprocess_reference(noisy), ref_sr)

    source_samples, source_sr = await edge_wav(SENTENCE, "ko-KR-SunHiNeural")
    source_wav = clone.encode_wav(source_samples, source_sr)

    await clone.ensure_loaded()

    # 첫 변환은 CUDA 커널 컴파일·캐시 워밍업 비용을 통째로 뒤집어써서 설정 간
    # 비교에 쓸 수 없다(10스텝이 25스텝보다 느리게 나온다). 버리는 한 방을 먼저.
    clone.DIFFUSION_STEPS = 10
    await clone.convert(source_wav, "audio/wav", ref_prep)

    async def run(ref_path, steps, out_name, repeats=2):
        clone.DIFFUSION_STEPS = steps
        best = None
        wav = None
        for _ in range(repeats):
            t0 = time.perf_counter()
            wav = await clone.convert(source_wav, "audio/wav", ref_path)
            elapsed = time.perf_counter() - t0
            best = elapsed if best is None else min(best, elapsed)
        (OUT / out_name).write_bytes(wav)
        samples, sr = clone.decode_audio(wav, "audio/wav")
        print(f"  {out_name}  steps={steps}  {best:.2f}s  ({len(samples)/sr:.1f}s audio)")
        rows.append((out_name, steps, Path(ref_path).name, round(best, 2)))

    # ── 03 디퓨전 스텝별 (전처리된 참조 기준) ───────────────────────────
    print("[03] 디퓨전 스텝")
    for steps in STEPS:
        await run(ref_prep, steps, f"03_clone_steps_{steps:02d}.wav")

    # ── 04 참조 전처리 유무 (스텝 고정) ─────────────────────────────────
    print("[04] 참조 전처리 유무 (steps=25)")
    await run(ref_raw, 25, "04_clone_ref_raw.wav")
    await run(ref_prep, 25, "04_clone_ref_preprocessed.wav")

    # ── 05 복제 경로에서 운율 보존 ──────────────────────────────────────
    print("[05] 복제 + 운율")
    clone.DIFFUSION_STEPS = 25
    for bucket in ("happy", "sad"):
        rate, pitch = st.prosody_for(bucket)
        s, sr = await edge_wav(SENTENCE, "ko-KR-SunHiNeural", rate, pitch)
        wav = await clone.convert(clone.encode_wav(s, sr), "audio/wav", ref_prep)
        (OUT / f"05_clone_prosody_{bucket}.wav").write_bytes(wav)
        print(f"  05_clone_prosody_{bucket}.wav  ({rate}/{pitch})")

    print("\n실측 표 (파일 | 스텝 | 참조 | 변환시간초)")
    for row in rows:
        print("  " + " | ".join(str(c) for c in row))
    print(f"\n출력 폴더: {OUT}")


if __name__ == "__main__":
    asyncio.run(main())
