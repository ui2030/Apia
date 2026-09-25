# -*- coding: utf-8 -*-
"""야간 학습기 — 누적 교재를 학생 모델(Qwen3-4B)에 QLoRA로 새기는 별도 프로세스.

**백엔드 프로세스가 아니다.** Electron이 `trainingPythonPath`(기본 night-loop-lab
venv)로 스폰하고, 이 파일은 그 venv의 unsloth/trl/peft만 쓴다. Apia 백엔드 venv에는
학습 스택이 없고, 넣으면 torch가 6.9GB 중복으로 깔린다.

백엔드에서 가져오는 것은 `ai_config` 하나뿐이다 — stdlib만 쓰는 모듈이라 학습용
venv에서도 그대로 읽히고, 덕분에 시스템 프롬프트와 MODEL_ID가 **서빙과 학습에서
같은 단일 출처**가 된다(둘이 어긋나면 델타는 서빙 때와 다른 조건에서 학습된다).

레시피는 night-loop-lab 실험(run_experiment/run_v2의 C'·D2군)에서 검증된 것을
옮긴 것이다. 그 파일들을 import하지는 않는다 — 실험 스크립트는 실험 데이터 경로에
묶여 있고, 여기서 필요한 건 학습 코어뿐이다.

  1. 누적 교재 전체를 모은다.
  2. on-policy 교정: 지금 서빙 중인 학생(베이스+채택 델타)이 교재 질문에 답하고,
     교사가 그 답을 교재 정답 기준으로 고친다. 교사가 죽었거나 예산이 마르면
     교정 없이 교재 원답으로 폴백한다(실험 D1 = D2보다 약간 낮지만 충분히 유효).
  3. 베이스에서 새로 QLoRA(r16) 전체 재학습.
  4. 고정 스모크 게이트: 일반 능력 10문항 + 이번 주 교재 표본 리콜. 학습 전후를
     같은 문항으로 재서 **열화했으면 델타를 버린다**.

채택 여부는 여기서 판정만 하고 파일 교체는 Electron이 한다(교재·델타 파일의
소유자는 Electron 하나 — courseware.js와 같은 규약).

종료 코드: 0 = 결과 JSON을 썼다(status는 그 안에). 1 = 쓰지 못할 만큼 일찍 죽었다.
"""

# unsloth가 transformers/trl보다 먼저 import돼야 패치가 걸린다. 이 venv에서는
# 순서를 어기면 transformers가 torchao와 충돌해 import 자체가 실패한다.
import unsloth  # noqa: F401  isort:skip

import argparse
import gc
import hashlib
import importlib.util
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent

# ── 학습 하이퍼파라미터 (night-loop-lab calib.py로 보정된 값) ──────────────────
MAXLEN = 512        # 실제 카드는 ~150토큰. 768은 12GB 카드에서 피크가 넘쳐 OOM
LR = 3e-4
EPOCHS = 9          # calib 결과 9ep에서 당일 팩트 리콜 100%
LORA_R, LORA_ALPHA = 16, 32
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
SEED = 1234

VRAM_MIN_GB = 8.0
CORRECT_BATCH = 10  # 교사에게 한 번에 주는 카드 수. 20개면 교사가 개수를 흘린다
RECALL_SAMPLE = 20
GEN_MAX_NEW = 96

# 고정 스모크 평가 — 일반 능력 10문항. 학습이 기반 능력을 부수지 않았는지만 본다.
# night-loop-lab data_v2의 general 셋 그대로(정답 문자열 포함 여부로 채점).
GENERAL_EVAL = [
    ("대한민국의 수도는 어디인가요?", ["서울"]),
    ("물이 끓는 온도는 섭씨 몇 도인가요?", ["100"]),
    ("1년은 보통 며칠인가요?", ["365"]),
    ("무지개는 보통 몇 가지 색으로 말하나요?", ["7", "일곱"]),
    ("태양계에서 가장 큰 행성은 무엇인가요?", ["목성"]),
    ("한글을 창제한 조선의 왕은 누구인가요?", ["세종"]),
    ("3 곱하기 7은 얼마인가요?", ["21"]),
    ("사람의 정상 체온은 섭씨 약 몇 도인가요?", ["36", "37"]),
    ("지구에서 가장 넓은 바다는 무엇인가요?", ["태평양"]),
    ("1킬로그램은 몇 그램인가요?", ["1000", "1,000", "천 그램"]),
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── 교재·유사도 ──────────────────────────────────────────────────────────────
def grams(text, n=2):
    """공백을 지운 문자열의 문자 n-gram 집합. courseware.js의 grams()와 같은 규칙."""
    s = "".join(str(text or "").split())
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def similarity(a, b):
    """문자 2-gram Jaccard. 카드 리콜 채점과 그림자 유사도가 같은 자를 쓴다."""
    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


def load_cards(cards_dir, max_cards):
    """cards/<YYYY-MM-DD>.jsonl 전부. 최신 날짜가 뒤로 오게 정렬하고 상한을 넘으면
    **오래된 쪽부터** 버린다 — 잘라야 한다면 최근 기억을 남기는 게 맞다."""
    out = []
    for path in sorted(Path(cards_dir).glob("*.jsonl")):
        day = path.stem
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                card = json.loads(line)
            except ValueError:
                continue  # 깨진 줄 하나로 그날 카드를 통째로 버리진 않는다
            u, a = str(card.get("u") or ""), str(card.get("a") or "")
            if u and a:
                out.append({"day": day, "u": u, "a": a})
    if max_cards and len(out) > max_cards:
        out = out[-max_cards:]
    return out


def corpus_hash(cards):
    h = hashlib.md5()
    for c in cards:
        h.update((c["u"] + "\x1f" + c["a"] + "\x1e").encode("utf-8"))
    return h.hexdigest()


# ── 교사 호출 (백엔드 경유) ──────────────────────────────────────────────────
#
# 교사 키도 예산 장부도 백엔드가 단독 관할한다(A-1의 teacher_service). 학습
# 프로세스가 DeepSeek을 직접 치면 일일 상한이 두 장부로 갈라져 무력해진다.
def correct_batch(backend_url, items, timeout=240):
    """토큰은 **env로만** 받는다 — 명령줄에 실으면 프로세스 목록에 노출된다."""
    payload = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        backend_url.rstrip("/") + "/training/correct",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Apia-Training-Token": os.environ.get("APIA_TRAINING_TOKEN", ""),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


# ── 모델 ────────────────────────────────────────────────────────────────────
def vram_free_gb():
    import torch
    return torch.cuda.mem_get_info()[0] / 1e9


def fresh_model(model_id, with_lora=True):
    from unsloth import FastLanguageModel
    model, tok = FastLanguageModel.from_pretrained(
        model_id, max_seq_length=MAXLEN, load_in_4bit=True, dtype=None)
    if with_lora:
        model = FastLanguageModel.get_peft_model(
            model, r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=0.0, bias="none",
            target_modules=TARGET_MODULES,
            use_gradient_checkpointing="unsloth", random_state=SEED)
    return model, tok


def release(model):
    import torch
    del model
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()


def generate(model, tok, prompts, system, max_new=GEN_MAX_NEW, bs=8):
    import torch
    from unsloth import FastLanguageModel
    try:
        FastLanguageModel.for_inference(model)
    except Exception:  # noqa: BLE001
        model.eval()
    old_side = tok.padding_side
    tok.padding_side = "left"
    outs = []
    with torch.inference_mode():
        for i in range(0, len(prompts), bs):
            chunk = prompts[i:i + bs]
            texts = [tok.apply_chat_template(
                [{"role": "system", "content": system}, {"role": "user", "content": p}],
                tokenize=False, add_generation_prompt=True) for p in chunk]
            enc = tok(texts, return_tensors="pt", padding=True,
                      truncation=True, max_length=MAXLEN).to("cuda")
            gen = model.generate(**enc, max_new_tokens=max_new, do_sample=False,
                                 use_cache=True, temperature=None, top_p=None, top_k=None,
                                 pad_token_id=tok.pad_token_id or tok.eos_token_id)
            for j in range(len(chunk)):
                outs.append(tok.decode(gen[j][enc["input_ids"].shape[1]:],
                                       skip_special_tokens=True))
    tok.padding_side = old_side
    try:
        FastLanguageModel.for_training(model)
    except Exception:  # noqa: BLE001
        model.train()
    return outs


def to_text(tok, card, system):
    """학습 텍스트 = 추론 때 쓰는 generation prompt + 정답 + eos.

    generation prompt를 그대로 쓰는 게 핵심이다. Qwen 템플릿은 assistant 턴 앞에
    생성 프롬프트에는 없는 토큰을 끼워 넣는데, 그대로 학습하면 모델이 그 자리를
    채우려고 쓰레기 토큰을 뱉는다.
    """
    prompt = tok.apply_chat_template(
        [{"role": "system", "content": system}, {"role": "user", "content": card["u"]}],
        tokenize=False, add_generation_prompt=True)
    return prompt + card["a"] + tok.eos_token


# ── 평가 ────────────────────────────────────────────────────────────────────
def norm(s):
    return "".join(str(s).split()).lower()


def evaluate(model, tok, system, recall_cards, tag):
    """일반 능력 %와 교재 리콜 %를 같은 문항으로 학습 전후 두 번 잰다."""
    t0 = time.time()
    g_out = generate(model, tok, [q for q, _ in GENERAL_EVAL], system)
    g_hits = [any(norm(a) in norm(o) for a in answers)
              for (_, answers), o in zip(GENERAL_EVAL, g_out)]
    general = 100.0 * sum(g_hits) / len(g_hits)

    recall = 0.0
    if recall_cards:
        r_out = generate(model, tok, [c["u"] for c in recall_cards], system)
        sims = [similarity(o, c["a"]) for c, o in zip(recall_cards, r_out)]
        recall = 100.0 * sum(sims) / len(sims)

    log(f"  EVAL[{tag}] general={general:.1f} recall={recall:.1f} ({time.time()-t0:.0f}s)")
    return {"general": round(general, 1), "recall": round(recall, 1)}


# ── 중단 신호 ────────────────────────────────────────────────────────────────
class Stopped(RuntimeError):
    """사용자 복귀(STOP 파일) / 시간 상한 / 부모(Electron) 소멸."""


def open_parent_watch(pid):
    """부모 프로세스를 감시할 핸들. **살아 있는 동안 한 번만** 연다.

    매번 PID로 조회하지 않는 이유: 부모가 죽은 뒤 같은 PID가 다른 프로세스에
    재사용되면 "아직 살아 있다"고 오판한다. 살아 있을 때 잡아 둔 핸들은 그
    프로세스 하나만 가리킨다.
    """
    if not pid:
        return None
    if os.name != "nt":
        return int(pid)
    import ctypes
    SYNCHRONIZE = 0x00100000
    handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, int(pid))
    return handle or None


def parent_alive(watch):
    if watch is None:
        return True
    if os.name != "nt":
        try:
            os.kill(watch, 0)
            return True
        except OSError:
            return False
    import ctypes
    # WAIT_OBJECT_0(0) = 이미 신호 상태 = 종료됨. WAIT_TIMEOUT(0x102) = 실행 중.
    return ctypes.windll.kernel32.WaitForSingleObject(watch, 0) != 0


class Guard:
    """중단 사유를 한 곳에서 판정한다. 스테이지 사이와 학습 스텝마다 물어본다."""

    def __init__(self, stop_file, deadline_sec, parent_pid=0):
        self.stop_file = Path(stop_file) if stop_file else None
        self.deadline = time.time() + deadline_sec if deadline_sec else None
        self.parent = open_parent_watch(parent_pid)
        self.reason = None

    def check(self):
        if self.stop_file is not None and self.stop_file.exists():
            self.reason = "user returned"
            raise Stopped(self.reason)
        if self.deadline is not None and time.time() > self.deadline:
            self.reason = "time limit"
            raise Stopped(self.reason)
        # Electron이 크래시하면 STOP 파일을 써 줄 주체가 없다. 그때 여기서
        # 스스로 끊지 않으면 학습이 유령으로 남아 GPU를 계속 문다.
        if not parent_alive(self.parent):
            self.reason = "parent gone"
            raise Stopped(self.reason)


def trainer_callback(guard):
    """TrainerCallback로 스텝마다 guard를 물어 중단을 즉시 반영한다."""
    from transformers import TrainerCallback

    class _Stop(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):
            try:
                guard.check()
            except Stopped:
                control.should_training_stop = True
                control.should_save = True
                self.stopped = True
            return control

    cb = _Stop()
    cb.stopped = False
    return cb


# ── 체크포인트 ──────────────────────────────────────────────────────────────
def clear_train_checkpoint(work):
    """HF 체크포인트 폐기. 교재가 바뀌었거나 학습이 끝난 뒤에 부른다.

    남겨 두면 다음 실행이 **다른 교재로 만든 체크포인트에서 재개한다** — 스텝
    수가 이미 차 있으면 한 스텝도 돌지 않고 옛 델타를 그대로 내놓는다.
    """
    import shutil
    shutil.rmtree(Path(work) / "hf", ignore_errors=True)


def load_state(work, expect_hash):
    """이전 시도의 진행 상태. 교재가 바뀌었으면 버린다 — 교정 답은 그 교재에만 유효."""
    path = Path(work) / "state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        clear_train_checkpoint(work)
        return {}
    if state.get("corpus_hash") != expect_hash:
        log("  checkpoint discarded (교재가 바뀌었다)")
        clear_train_checkpoint(work)
        return {}
    return state


def save_state(work, state):
    path = Path(work) / "state.json"
    tmp = path.with_suffix(".json.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# ── 단계 ────────────────────────────────────────────────────────────────────
CORRECT_SYSTEM_NOTE = "on-policy correction"


def stage_correct(args, cards, system, guard, state):
    """학생이 먼저 답하고 교사가 고친다. 실패하면 교재 원답 그대로(D1 폴백).

    돈과 시간이 드는 유일한 단계라 결과를 체크포인트에 적는다. 다음 기회에
    재개하면 여기를 건너뛰므로 교사 비용이 두 번 나가지 않는다.
    """
    if state.get("corrected"):
        log(f"  resume: 교정 {len(state['corrected'])}장 재사용 (교사 호출 없음)")
        return state["corrected"], state.get("teacher_spent", 0.0), state.get("corrected_by", "resumed")

    if not args.backend_url:
        log("  on-policy 생략: 백엔드 URL 없음 → 교재 SFT 폴백")
        return [dict(c) for c in cards], 0.0, "fallback:no-backend"

    guard.check()
    model, tok = fresh_model(args.model, with_lora=False)
    adopted = args.adopted_delta
    if adopted and Path(adopted).exists():
        try:
            model.load_adapter(adopted, adapter_name="adopted")
            log(f"  student = base + adopted delta ({Path(adopted).name})")
        except Exception as error:  # noqa: BLE001
            log(f"  !! adopted delta 로드 실패({type(error).__name__}) — 베이스로 진행")
    t0 = time.time()
    student = generate(model, tok, [c["u"] for c in cards], system)
    log(f"  student answered {len(cards)} cards in {time.time()-t0:.0f}s")
    release(model)

    fixed, spent, failures = [], 0.0, 0
    budget_done = False
    for i in range(0, len(cards), CORRECT_BATCH):
        guard.check()
        chunk = cards[i:i + CORRECT_BATCH]
        if budget_done:
            fixed += [c["a"] for c in chunk]
            continue
        items = [{"q": c["u"], "ref": c["a"], "a": s.strip()[:400]}
                 for c, s in zip(chunk, student[i:i + CORRECT_BATCH])]
        try:
            res = correct_batch(args.backend_url, items)
        except Exception as error:  # noqa: BLE001
            log(f"  !! 교정 배치 실패({type(error).__name__}) — 교재 원답 사용")
            fixed += [c["a"] for c in chunk]
            failures += 1
            continue
        spent = float(res.get("spent_week") or spent)
        answers = res.get("answers")
        if res.get("status") != "ok" or not isinstance(answers, list) or len(answers) != len(chunk):
            log(f"  !! 교정 미채택({res.get('status')}: {res.get('reason')}) — 교재 원답 사용")
            fixed += [c["a"] for c in chunk]
            if res.get("status") == "deferred":
                budget_done = True  # 예산/키 문제는 다음 배치도 똑같다 — 더 묻지 않는다
            else:
                failures += 1
            continue
        fixed += [str(x) for x in answers]

    corrected = [{"u": c["u"], "a": f, "day": c["day"]} for c, f in zip(cards, fixed)]
    mode = "fallback:teacher" if (budget_done or failures) else "on-policy"
    state.update({"corrected": corrected, "teacher_spent": spent, "corrected_by": mode})
    save_state(args.work, state)
    log(f"  on-policy 교정 완료 ({mode}) / 주간 교사 지출 ${spent:.4f}")
    return corrected, spent, mode


def stage_train(args, corpus, system, recall_cards, guard):
    """베이스에서 새로 QLoRA. 학습 전후를 같은 문항으로 재서 게이트에 넘긴다."""
    import torch
    from datasets import Dataset
    from trl import SFTTrainer, SFTConfig

    guard.check()
    model, tok = fresh_model(args.model)
    before = evaluate(model, tok, system, recall_cards, "before")

    ds = Dataset.from_list([{"text": to_text(tok, c, system)} for c in corpus])
    ckpt_dir = Path(args.work) / "hf"
    cb = trainer_callback(guard)
    torch.cuda.reset_peak_memory_stats()
    trainer = SFTTrainer(
        model=model, train_dataset=ds, processing_class=tok,
        callbacks=[cb],
        args=SFTConfig(dataset_text_field="text", max_length=MAXLEN,
                       per_device_train_batch_size=2, gradient_accumulation_steps=2,
                       num_train_epochs=EPOCHS, warmup_ratio=0.05, learning_rate=LR,
                       logging_steps=1000, optim="adamw_8bit", weight_decay=0.01,
                       lr_scheduler_type="linear", seed=SEED, data_seed=SEED,
                       output_dir=str(ckpt_dir), report_to="none",
                       save_strategy="steps", save_steps=50, save_total_limit=1,
                       disable_tqdm=True,
                       bf16=torch.cuda.is_bf16_supported(),
                       fp16=not torch.cuda.is_bf16_supported()))

    resume = any(ckpt_dir.glob("checkpoint-*")) if ckpt_dir.exists() else False
    t0 = time.time()
    try:
        stats = trainer.train(resume_from_checkpoint=resume or None)
    except Exception as error:  # noqa: BLE001
        if resume:
            # 체크포인트가 지금 설정과 안 맞을 수 있다(카드 수가 바뀌면 총 스텝이
            # 달라진다). 재개 실패로 학습 기능 전체를 잃는 것보다 처음부터가 낫다.
            log(f"  !! 재개 실패({type(error).__name__}) — 처음부터 학습")
            stats = trainer.train()
        elif "out of memory" in str(error).lower():
            log("  OOM — 캐시를 비우고 한 번 재시도")
            gc.collect(); torch.cuda.empty_cache(); time.sleep(20)
            stats = trainer.train()
        else:
            raise
    peak = torch.cuda.max_memory_reserved() / 1e9
    log(f"  train n={len(corpus)} steps={int(stats.global_step)} {time.time()-t0:.0f}s "
        f"loss={stats.training_loss:.3f} peak={peak:.2f}GB")

    if getattr(cb, "stopped", False):
        # 중간에 끊겼다 — 델타를 내보내지 않는다. HF 체크포인트는 남으므로 다음
        # 기회에 그 자리에서 이어 붙는다.
        del trainer
        release(model)
        raise Stopped(guard.reason or "interrupted")

    after = evaluate(model, tok, system, recall_cards, "after")
    candidate = Path(args.work) / "candidate"
    if candidate.exists():
        for item in candidate.iterdir():
            item.unlink()
    model.save_pretrained(str(candidate))
    tok.save_pretrained(str(candidate))
    del trainer
    release(model)
    # 이 교재로 할 학습은 끝났다. 체크포인트는 **중단된 학습**을 위한 것이지
    # 완료된 학습을 되살리는 물건이 아니다.
    clear_train_checkpoint(args.work)
    return {
        "before": before, "after": after, "candidate": str(candidate),
        "steps": int(stats.global_step), "loss": round(float(stats.training_loss), 4),
        "sec": round(time.time() - t0, 1), "vram_peak_gb": round(peak, 2),
        "n_cards": len(corpus),
    }


def gate(result, general_drop_max, recall_gain_min):
    """학습 전후 비교. 기반 능력이 무너졌거나 교재를 못 외웠으면 폐기."""
    before, after = result["before"], result["after"]
    general_drop = before["general"] - after["general"]
    recall_gain = after["recall"] - before["recall"]
    reasons = []
    if general_drop > general_drop_max:
        reasons.append(f"일반 능력 {before['general']}→{after['general']} "
                       f"({general_drop:.1f}p 하락 > 허용 {general_drop_max}p)")
    if recall_gain < recall_gain_min:
        reasons.append(f"교재 리콜 {before['recall']}→{after['recall']} "
                       f"({recall_gain:+.1f}p < 요구 {recall_gain_min}p)")
    return {
        "passed": not reasons,
        "general_before": before["general"], "general_after": after["general"],
        "recall_before": before["recall"], "recall_after": after["recall"],
        "general_drop_max": general_drop_max, "recall_gain_min": recall_gain_min,
        "reason": " / ".join(reasons) or "통과",
    }


# ── 진입점 ──────────────────────────────────────────────────────────────────
def write_result(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
    log(f"result -> {payload.get('status')}: {payload.get('reason', '')}")


def load_system_prompt():
    """ai_config(stdlib 전용)에서 서빙과 같은 시스템 프롬프트·모델을 읽는다."""
    spec = importlib.util.spec_from_file_location(
        "apia_ai_config", BACKEND_DIR / "ai_config.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SYSTEM_PROMPT, module.MODEL_ID


def main():
    default_system, default_model = load_system_prompt()
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", required=True, help="courseware cards 디렉터리")
    ap.add_argument("--work", required=True, help="체크포인트·후보 델타 작업 디렉터리")
    ap.add_argument("--result", required=True, help="결과 JSON 경로")
    ap.add_argument("--model", default=default_model)
    ap.add_argument("--backend-url", default="")
    ap.add_argument("--adopted-delta", default="", help="현재 채택 델타(학생 초기값)")
    ap.add_argument("--stop-file", default="")
    ap.add_argument("--parent-pid", type=int, default=0)
    ap.add_argument("--deadline-sec", type=int, default=7200)
    ap.add_argument("--since", default="", help="이번 주 시작일 — 리콜 표본 범위")
    ap.add_argument("--max-cards", type=int, default=2000)
    ap.add_argument("--general-drop-max", type=float, default=20.0)
    ap.add_argument("--recall-gain-min", type=float, default=10.0)
    args = ap.parse_args()

    system = default_system
    guard = Guard(args.stop_file, args.deadline_sec, args.parent_pid)
    started = time.time()
    base = {"started_at": time.time(), "model": args.model}

    try:
        free = vram_free_gb()
        log(f"VRAM free {free:.2f} GB")
        if free < VRAM_MIN_GB:
            write_result(args.result, dict(base, status="deferred",
                                           reason=f"VRAM {free:.1f}GB < {VRAM_MIN_GB}GB"))
            return 0

        cards = load_cards(args.cards, args.max_cards)
        log(f"cards {len(cards)}장")
        if not cards:
            write_result(args.result, dict(base, status="deferred", reason="교재 없음"))
            return 0

        chash = corpus_hash(cards)
        state = load_state(args.work, chash)
        state["corpus_hash"] = chash

        week = [c for c in cards if not args.since or c["day"] > args.since] or cards
        random.Random(SEED).shuffle(week)
        recall_cards = week[:RECALL_SAMPLE]

        corpus, spent, mode = stage_correct(args, cards, system, guard, state)
        result = stage_train(args, corpus, system, recall_cards, guard)
        verdict = gate(result, args.general_drop_max, args.recall_gain_min)

        write_result(args.result, dict(
            base, status="passed" if verdict["passed"] else "discarded",
            reason=verdict["reason"], gate=verdict, train=result,
            corrected_by=mode, teacher_spent_week=spent,
            candidate=result["candidate"] if verdict["passed"] else None,
            elapsed_sec=round(time.time() - started, 1)))
        return 0

    except Stopped as error:
        write_result(args.result, dict(base, status="interrupted", reason=str(error),
                                       elapsed_sec=round(time.time() - started, 1)))
        return 0
    except Exception as error:  # noqa: BLE001
        log(f"!! FAILED {type(error).__name__}: {error}")
        write_result(args.result, dict(base, status="failed",
                                       reason=f"{type(error).__name__}: {error}"[:300],
                                       elapsed_sec=round(time.time() - started, 1)))
        return 0


def selfcheck():
    """ponytail: GPU 없이 도는 산식 검사. 유사도·게이트·교재 로딩이 깨지면 여기서 걸린다."""
    import tempfile
    assert grams("가나다") == {"가나", "나다"}
    assert similarity("", "x") == 0.0
    assert similarity("고양이 이름은 모루", "고양이 이름은 모루") == 1.0
    assert 0.0 < similarity("고양이 이름은 모루다", "고양이는 모루라고 불러") < 1.0

    ok = gate({"before": {"general": 80.0, "recall": 10.0},
               "after": {"general": 80.0, "recall": 40.0}}, 20.0, 10.0)
    assert ok["passed"], ok
    broke = gate({"before": {"general": 80.0, "recall": 10.0},
                  "after": {"general": 40.0, "recall": 40.0}}, 20.0, 10.0)
    assert not broke["passed"] and "일반 능력" in broke["reason"], broke
    lazy = gate({"before": {"general": 80.0, "recall": 30.0},
                 "after": {"general": 80.0, "recall": 31.0}}, 20.0, 10.0)
    assert not lazy["passed"] and "리콜" in lazy["reason"], lazy

    with tempfile.TemporaryDirectory() as d:
        Path(d, "2026-01-01.jsonl").write_text(
            '{"day":"2026-01-01","u":"q1","a":"a1"}\nbroken\n{"u":"q2","a":"a2"}\n',
            encoding="utf-8")
        Path(d, "2026-01-02.jsonl").write_text(
            '{"day":"2026-01-02","u":"q3","a":"a3"}\n', encoding="utf-8")
        cards = load_cards(d, 0)
        assert [c["u"] for c in cards] == ["q1", "q2", "q3"], cards
        assert [c["u"] for c in load_cards(d, 2)] == ["q2", "q3"]
        assert corpus_hash(cards) == corpus_hash(load_cards(d, 0))

        state = {"corpus_hash": "abc", "corrected": [1]}
        save_state(d, state)
        Path(d, "hf", "checkpoint-72").mkdir(parents=True)
        assert load_state(d, "abc")["corrected"] == [1]
        assert Path(d, "hf", "checkpoint-72").exists()   # 같은 교재면 이어 붙는다
        assert load_state(d, "zzz") == {}                # 교재가 바뀌면 교정도
        assert not Path(d, "hf").exists()                # 학습 체크포인트도 무효

    g = Guard(None, 0)
    g.check()  # 상한 0 = 무제한, 부모 감시 없음
    stop = Path(tempfile.gettempdir()) / "night_trainer_selfcheck.stop"
    stop.write_text("x", encoding="utf-8")
    try:
        g2 = Guard(stop, 7200)
        try:
            g2.check()
            raise AssertionError("STOP 파일을 무시했다")
        except Stopped:
            pass
    finally:
        stop.unlink()

    # 부모 소멸 감시 — 살아 있는 자식을 부모라고 속여 잡았다가 죽인다.
    import subprocess
    victim = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                              stdin=subprocess.PIPE)
    try:
        g3 = Guard(None, 7200, victim.pid)   # 살아 있는 동안 핸들을 잡는다
        assert parent_alive(g3.parent), "살아 있는 부모를 죽었다고 봤다"
        g3.check()                            # 살아 있으면 통과
    finally:
        victim.stdin.close()
        victim.wait(timeout=30)
    assert not parent_alive(g3.parent), "죽은 부모를 살아 있다고 봤다"
    try:
        g3.check()
        raise AssertionError("부모가 사라졌는데 계속 돌았다")
    except Stopped as error:
        assert str(error) == "parent gone", error
    print("selfcheck ok")


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        selfcheck()
    else:
        sys.exit(main())
