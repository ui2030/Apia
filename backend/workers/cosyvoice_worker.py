# -*- coding: utf-8 -*-
"""CosyVoice3 synthesis worker — runs in the *experiment* venv, not the backend's.

The backend never imports CosyVoice: torch/torchaudio/matcha pull a different
dependency set than the packaged backend, and a bad import would take the whole
FastAPI process down. So this file is spawned as a separate interpreter and
talks JSON lines over stdin/stdout.

Protocol (one JSON object per line, UTF-8):
    <- {"id": "...", "text": "...", "prompt_wav": "...", "prompt_text": "..."}
    -> {"id": "...", "wav_path": "...", "mime": "audio/wav", "duration_ms": 0}
    -> {"id": "...", "error": "..."}
One unsolicited line is emitted once the model is resident:
    -> {"id": "__ready__", "sample_rate": 24000}

**stdout is protocol-only.** torch/cosyvoice print progress bars and warnings on
import, so stdout is swapped to stderr before any of that is imported; the real
handle is kept private in `_out`. The parent treats any unparseable stdout line
as a failed request and respawns.

prompt_text present -> zero-shot cloning (transcript known, best quality).
prompt_text absent   -> cross-lingual (user-supplied reference with no
transcript). A *Korean* reference matters either way: a Chinese reference
bleeds Chinese phonology into Korean output (measured: 뭐 -> 모).
"""
import json
import os
import sys
import time

# Must happen before torch/cosyvoice import — they write to stdout.
_out = sys.stdout
sys.stdout = sys.stderr

# CosyVoice3 zero-shot expects the prompt transcript behind this marker
# (gen_ko.py in the experiment folder does the same).
SYS_PREFIX = "You are a helpful assistant.<|endofprompt|>"


def _emit(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def _synthesize(model, req):
    import torch

    text = req["text"]
    prompt_wav = req["prompt_wav"]
    prompt_text = (req.get("prompt_text") or "").strip()

    if prompt_text:
        stream = model.inference_zero_shot(
            text, SYS_PREFIX + prompt_text, prompt_wav, stream=False
        )
    else:
        stream = model.inference_cross_lingual(text, prompt_wav, stream=False)

    chunks = [chunk["tts_speech"] for chunk in stream]
    if not chunks:
        raise RuntimeError("model produced no audio")
    return torch.concat(chunks, dim=1)


def main():
    if len(sys.argv) < 4:
        _emit({"id": "__ready__", "error": "usage: worker <repo> <model_dir> <out_dir>"})
        return 2
    repo, model_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]

    # cosyvoice resolves asset/ and config paths relative to the repo root.
    os.chdir(repo)
    sys.path.insert(0, repo)
    sys.path.insert(0, os.path.join(repo, "third_party", "Matcha-TTS"))

    try:
        import torchaudio
        from cosyvoice.cli.cosyvoice import AutoModel

        model = AutoModel(model_dir=model_dir, fp16=True)
    except Exception as error:
        _emit({"id": "__ready__", "error": f"{type(error).__name__}: {error}"})
        return 1

    _emit({"id": "__ready__", "sample_rate": int(model.sample_rate)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as error:
            _emit({"id": "", "error": f"bad request: {error}"})
            continue

        req_id = str(req.get("id") or "")
        try:
            started = time.time()
            wav = _synthesize(model, req)
            wav_path = os.path.join(out_dir, f"{req_id}.wav")
            # PCM_16 고정: torchaudio 기본값은 float32 wav라 payload가 2배가 되고
            # (base64 IPC로 렌더러까지 간다) 백엔드의 다른 wav 경로도 전부 PCM_16이다.
            torchaudio.save(
                wav_path, wav, model.sample_rate, encoding="PCM_S", bits_per_sample=16
            )
            print(
                "[worker] %s: %.2fs" % (req_id, time.time() - started), file=sys.stderr
            )
            _emit({
                "id": req_id,
                "wav_path": wav_path,
                "mime": "audio/wav",
                "duration_ms": int(wav.shape[1] / model.sample_rate * 1000),
            })
        except Exception as error:
            _emit({"id": req_id, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
