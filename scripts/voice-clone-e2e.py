# -*- coding: utf-8 -*-
"""
음성 복제 E2E (라이브 백엔드 HTTP) — GPU·네트워크 필요한 수동 검증 도구.

백엔드를 임시 DATA_DIR로 띄우고 실제 사용자 흐름을 그대로 친다:
  ① POST /voices/upload (참조 WAV multipart)
  ② GET /voices/train/{job} 1초 폴링 — 게이지 단조 증가·done 도달
  ③ GET /voices — custom: 음성 노출
  ④ GET /voices/custom:{id}/preview — audio/wav
  ⑤ POST /tts (voice_id=custom:…) — audio/wav + 폴백 헤더 없음
  ⑥ POST /tts 직후 한 번 더 — 모델이 이미 로드돼 있으니 역시 비폴백
  ⑦ DELETE /voices/custom:{id} → 목록에서 사라짐

실행: python scripts/voice-clone-e2e.py  (Apia 루트, 사전: voice-clone-smoke 1회로 체크포인트 캐시)
"""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
REF_WAV = ROOT / "test-results" / "voice-clone-smoke" / "reference.wav"
PORT = 8731
BASE = f"http://127.0.0.1:{PORT}"

assert REF_WAV.exists(), "먼저 scripts/voice-clone-smoke.py를 실행해 참조 음성을 만들어 두세요"

import httpx  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="apia-vc-e2e-")
env = {
    **os.environ,
    "DATA_DIR": data_dir,
    "APIA_BACKEND_PORT": str(PORT),
    "KMP_DUPLICATE_LIB_OK": "TRUE",
}
backend_log = open(Path(data_dir) / "backend.log", "w", encoding="utf-8", errors="replace")
proc = subprocess.Popen(
    [sys.executable, "main.py"], cwd=ROOT / "backend", env=env,
    stdout=backend_log, stderr=subprocess.STDOUT,
)

failures = []

def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)

try:
    for _ in range(180):
        if proc.poll() is not None:
            break
        try:
            if httpx.get(f"{BASE}/health", timeout=2).status_code == 200:
                break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError("backend did not start (timeout)")
    if proc.poll() is not None:
        backend_log.flush()
        tail = (Path(data_dir) / "backend.log").read_text(encoding="utf-8", errors="replace")[-3000:]
        raise RuntimeError(f"backend exited rc={proc.returncode}\n{tail}")
    print("[backend up]")

    # ① 업로드
    with open(REF_WAV, "rb") as f:
        r = httpx.post(f"{BASE}/voices/upload", timeout=60,
                       files={"file": ("reference.wav", f, "audio/wav")},
                       data={"name": "E2E 캐릭터"})
    check("upload 200", r.status_code == 200, str(r.status_code))
    job_id = r.json().get("job_id")
    check("job_id 발급", bool(job_id), str(r.json()))

    # ② 게이지 폴링
    seen = []
    status = None
    for _ in range(300):
        p = httpx.get(f"{BASE}/voices/train/{job_id}", timeout=5).json()
        if not seen or p["progress"] != seen[-1]:
            seen.append(p["progress"])
            print(f"    gauge: {p['status']} {p['progress']}%")
        status = p["status"]
        if status in ("done", "error"):
            break
        time.sleep(1)
    check("done 도달", status == "done", f"status={status} err={p.get('error')}")
    check("게이지 단조 증가", all(b >= a for a, b in zip(seen, seen[1:])), str(seen))
    voice_id = p.get("voice_id")
    public_id = f"custom:{voice_id}"

    # ③ 목록 노출
    voices = httpx.get(f"{BASE}/voices", timeout=10).json()
    listed = [v["id"] for v in voices.get("voices", [])]
    check("custom 음성 목록 노출", public_id in listed, str(listed))

    # ④ 미리듣기
    r = httpx.get(f"{BASE}/voices/{public_id}/preview", timeout=15)
    check("preview audio/wav", r.status_code == 200 and r.headers.get("content-type", "").startswith("audio/"),
          f"{r.status_code} {r.headers.get('content-type')} {len(r.content)}B")

    # ⑤⑥ custom TTS 2연속 — 비폴백 + WAV
    for i in (1, 2):
        t0 = time.time()
        r = httpx.post(f"{BASE}/tts", timeout=60,
                       json={"text": "복제 음성 확인입니다. 잘 들리나요?", "voice_id": public_id})
        fb = r.headers.get("x-apia-tts-fallback")
        check(f"custom tts #{i} wav·비폴백", r.status_code == 200
              and r.headers.get("content-type") == "audio/wav" and fb is None,
              f"{time.time()-t0:.1f}s {len(r.content)}B fallback={fb}")

    # ⑦ 삭제
    r = httpx.delete(f"{BASE}/voices/{public_id}", timeout=10)
    voices = httpx.get(f"{BASE}/voices", timeout=10).json()
    listed = [v["id"] for v in voices.get("voices", [])]
    check("삭제 후 목록 제거", r.status_code == 200 and public_id not in listed, str(listed))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

print(f"\n{'VOICE CLONE E2E FAILED: ' + str(failures) if failures else 'VOICE CLONE E2E PASSED'}")
sys.exit(1 if failures else 0)
