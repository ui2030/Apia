# -*- coding: utf-8 -*-
"""교사(DeepSeek) 클라이언트 — 일일 비용 상한과 사용량 집계를 가진 stdlib HTTP 호출.

교재 파이프라인 전용이다. 대화 경로(routers/chat.py)는 이 모듈을 쓰지 않는다 —
교사가 죽어 있든 예산이 말랐든 사용자가 눈치챌 수 있는 표면이 없어야 한다.

키 취급: `DEEPSEEK_API_KEY`는 backend.env에서만 읽고 로그·예외 메시지에 절대
싣지 않는다. urllib의 HTTPError 문자열이 요청 헤더를 물고 나오는 일은 없지만,
예외를 통째로 넘기지 않고 타입/상태코드만 직접 조립해서 그 가능성도 닫는다.

ponytail: openai SDK를 새로 깔지 않는다. 요청이 하나뿐이라 urllib이 더 짧다.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import ai_config  # noqa: F401  — import 부수효과로 backend.env를 os.environ에 로드

# DeepSeek 요금 (USD / 1M tok). 상한 가드용이라 보수적으로 높게 잡는다.
PRICE_IN_MISS, PRICE_IN_HIT, PRICE_OUT = 0.27, 0.07, 1.10

# 일일 교사 지출 상한 (발주서 §2). 하루 단위로 리셋된다.
DAILY_BUDGET_USD = 0.07

# 용도별 **추가** 상한. 일일 상한과 AND로 걸린다 — 버킷 상한이 남아도 일일 상한에
# 닿으면 못 쓰고, 그 반대도 마찬가지다. 야간 학습의 on-policy 교정은 일일 예산을
# 하루에 다 태워버릴 수 있는 유일한 대량 호출이라 주 단위로 한 번 더 묶는다.
ON_POLICY_BUCKET = "onpolicy"
ON_POLICY_WEEKLY_USD = 0.10
_WEEK_DAYS = 7

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"

# 교사 호출 전체(예산 확인 → HTTP → 장부 기록)를 직렬화한다. 나눠 잠그면 두
# 호출이 같은 잔액을 함께 통과해 상한을 넘긴다.
# ponytail: 프로세스 전역 락 하나. 교사 호출은 하루 몇 번이라 경합이 없다.
# 여러 프로세스가 같은 장부를 쓰게 되면 파일 락으로 올려야 한다.
_LOCK = threading.Lock()

# 장부를 읽지도 쓰지도 못하면 지출을 셀 수 없다 = 상한을 지킬 수 없다.
# 그때는 호출을 막는다(fail-closed). 백엔드가 다시 뜰 때까지 유지된다.
_ledger_broken: Optional[str] = None


class TeacherUnavailable(RuntimeError):
    """키 없음 / 예산 소진 — 실패가 아니라 '오늘은 하지 않는다'."""


class TeacherFailed(RuntimeError):
    """호출은 시도했으나 쓸 수 있는 결과가 안 나왔다."""


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _usage_path() -> Path:
    raw = os.getenv("DATA_DIR", "").strip()
    base = Path(raw) if raw else Path(__file__).resolve().parent.parent
    return base / "teacher_usage.json"


def _load_usage() -> Dict[str, Dict[str, float]]:
    """장부를 읽는다. **없으면** 빈 장부, **못 읽으면** 예외.

    둘을 뭉개면 안 된다: 깨진 장부를 0원으로 읽는 순간 상한이 사라진다.
    """
    path = _usage_path()
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("usage ledger is not a JSON object")
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def _load_usage_safe() -> Dict[str, Dict[str, float]]:
    """표시용 읽기. 실패는 0으로 뭉갠다 — 가드 판단에는 절대 쓰지 않는다."""
    try:
        return _load_usage()
    except Exception:  # noqa: BLE001
        return {}


def _save_usage(usage: Dict[str, Dict[str, float]]) -> None:
    """실패하면 던진다. 지출을 적지 못했다는 사실을 호출자가 알아야 한다."""
    # 최근 7일만 남긴다 — 관측 표면이 7일치 지출이고, 그보다 오래된 건 쓸 데가 없다.
    for day in sorted(usage)[:-7]:
        usage.pop(day, None)
    path = _usage_path()
    tmp = path.parent / (path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(usage, indent=1), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def spent_today() -> float:
    return float(_load_usage_safe().get(_today(), {}).get("usd", 0.0))


def spend_window() -> Dict[str, float]:
    return {day: float(rec.get("usd", 0.0)) for day, rec in _load_usage_safe().items()}


def _bucket_key(bucket: str) -> str:
    return f"usd_{bucket}"


def _bucket_window(usage: Dict[str, Dict[str, float]], bucket: str) -> float:
    """최근 7일의 버킷 지출 합. 날짜 키로 정렬해서 센다 — 장부가 7일치만 보존하긴
    하지만, 합산 기준을 dict 삽입 순서에 맡기면 손으로 고친 장부에서 틀린다."""
    key = _bucket_key(bucket)
    return sum(float(usage[day].get(key, 0.0)) for day in sorted(usage)[-_WEEK_DAYS:])


def on_policy_spent_week() -> float:
    return _bucket_window(_load_usage_safe(), ON_POLICY_BUCKET)


def _record(
    usage: Dict[str, Dict[str, float]], hit: int, miss: int, out: int,
    bucket: Optional[str] = None,
) -> float:
    """이미 읽어 둔 장부에 이번 호출을 더해 저장한다. 저장 실패는 던진다."""
    day = usage.setdefault(_today(), {"calls": 0, "in_hit": 0, "in_miss": 0, "out": 0, "usd": 0.0})
    day["calls"] = int(day.get("calls", 0)) + 1
    day["in_hit"] = int(day.get("in_hit", 0)) + hit
    day["in_miss"] = int(day.get("in_miss", 0)) + miss
    day["out"] = int(day.get("out", 0)) + out
    cost = (hit * PRICE_IN_HIT + miss * PRICE_IN_MISS + out * PRICE_OUT) / 1e6
    day["usd"] = float(day.get("usd", 0.0)) + cost
    if bucket:
        day[_bucket_key(bucket)] = float(day.get(_bucket_key(bucket), 0.0)) + cost
    _save_usage(usage)
    return float(day["usd"])


def _credentials() -> Tuple[str, str, str]:
    key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise TeacherUnavailable("no DEEPSEEK_API_KEY")
    base = os.getenv("DEEPSEEK_BASE_URL", "").strip() or DEFAULT_BASE_URL
    model = os.getenv("DEEPSEEK_MODEL", "").strip() or DEFAULT_MODEL
    return key, base.rstrip("/"), model


def has_key() -> bool:
    return bool(os.getenv("DEEPSEEK_API_KEY", "").strip())


def ask_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 3000,
    temperature: float = 0.3,
    timeout: int = 180,
    bucket: Optional[str] = None,
    bucket_weekly_cap: Optional[float] = None,
) -> Tuple[Dict[str, Any], float]:
    """교사 1회 호출(JSON 모드). `(파싱된 JSON, 오늘 누적 지출)`.

    `system`은 호출 종류마다 **고정 문자열**이어야 prefix 캐시가 붙어 단가가 내려간다.

    `bucket`을 주면 그 용도의 지출을 따로 적고, `bucket_weekly_cap`이 있으면 최근
    7일 합을 일일 상한과 **함께** 검사한다(둘 다 통과해야 호출한다).

    예산 확인부터 장부 기록까지가 한 임계구역이다 — 확인과 기록 사이에 다른
    호출이 끼면 둘이 같은 잔액을 보고 함께 통과한다.
    """
    global _ledger_broken

    with _LOCK:
        if _ledger_broken:
            raise TeacherUnavailable(f"usage ledger unavailable: {_ledger_broken}")

        key, base, model = _credentials()

        # 호출 전 가드. 상한에 닿았으면 그날은 더 쓰지 않는다(다음날 자동 리셋).
        # 장부를 못 읽으면 지출을 셀 수 없으니 쓰지 않는다(fail-closed).
        try:
            ledger = _load_usage()
        except Exception as error:  # noqa: BLE001
            _ledger_broken = f"read failed ({type(error).__name__})"
            raise TeacherUnavailable(f"usage ledger unavailable: {_ledger_broken}") from None
        already = float(ledger.get(_today(), {}).get("usd", 0.0))
        if already >= DAILY_BUDGET_USD:
            raise TeacherUnavailable(f"daily budget reached (${already:.4f} >= ${DAILY_BUDGET_USD})")
        if bucket and bucket_weekly_cap is not None:
            week = _bucket_window(ledger, bucket)
            if week >= bucket_weekly_cap:
                raise TeacherUnavailable(
                    f"{bucket} weekly budget reached (${week:.4f} >= ${bucket_weekly_cap})"
                )

        return _call_locked(key, base, model, ledger, system, user, max_tokens,
                            temperature, timeout, bucket)


def _call_locked(key, base, model, ledger, system, user, max_tokens, temperature, timeout,
                 bucket=None):
    """_LOCK을 쥔 채로만 부른다. HTTP 왕복과 장부 기록이 한 덩어리."""
    global _ledger_broken

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # 상태코드만 남긴다 — 응답 본문에 요청 에코가 섞여 키가 샐 여지를 없앤다.
        raise TeacherFailed(f"HTTP {error.code}") from None
    except Exception as error:  # noqa: BLE001
        raise TeacherFailed(type(error).__name__) from None

    usage = payload.get("usage") or {}
    hit = int(usage.get("prompt_cache_hit_tokens", 0) or 0)
    miss = int(usage.get("prompt_cache_miss_tokens", int(usage.get("prompt_tokens", 0) or 0) - hit) or 0)
    out = int(usage.get("completion_tokens", 0) or 0)
    try:
        total = _record(ledger, hit, max(miss, 0), out, bucket)
    except Exception as error:  # noqa: BLE001
        # 이미 쓴 돈이라 결과는 돌려준다(버리면 원본만 더 오래 남는다). 대신
        # 다음 호출부터 막는다 — 적지 못한 지출이 쌓이는 쪽이 훨씬 나쁘다.
        _ledger_broken = f"write failed ({type(error).__name__})"
        total = float(ledger.get(_today(), {}).get("usd", 0.0))  # 메모리상 값은 맞다

    try:
        text = payload["choices"][0]["message"]["content"]
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001
        raise TeacherFailed("teacher returned non-JSON") from None
    if not isinstance(parsed, dict):
        raise TeacherFailed("teacher returned non-object JSON")
    return parsed, total


def budget_snapshot() -> Dict[str, Optional[float]]:
    return {
        "budget_usd": DAILY_BUDGET_USD,
        "spent_today": spent_today(),
        "spend_7d": sum(spend_window().values()),
    }


def on_policy_snapshot() -> Dict[str, float]:
    return {
        "budget_week_usd": ON_POLICY_WEEKLY_USD,
        "spent_week": on_policy_spent_week(),
    }
