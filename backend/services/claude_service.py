"""
Unified AI service with runtime-selectable providers and deployment-safe
auto fallback behavior.
"""

import asyncio
import importlib.util
import json
import re
from typing import Any, List, Optional, Tuple

from ai_config import (
    AI_MODE,
    AUTO_MODE_PRIORITY,
    MODEL_ID,
    HF_TOKEN,
    ANTHROPIC_KEY,
    GROQ_KEY,
    CLAUDE_MODEL,
    GROQ_MODEL,
    SYSTEM_PROMPT,
    MAX_NEW_TOKENS,
    TEMPERATURE,
    TOP_P,
    DEFAULT_MEMORY_TURNS,
    LOADED_ENV_FILE,
)


class ClaudeService:
    def __init__(self):
        print(f"[AI] default_mode={AI_MODE} model={MODEL_ID}")
        if LOADED_ENV_FILE:
            print(f"[AI] loaded env file: {LOADED_ENV_FILE}")
        self.default_mode = AI_MODE
        self.mode = AI_MODE
        self.valid_modes = {"auto", "local", "hf_api", "claude", "groq"}
        self.auto_mode_priority = [
            mode for mode in AUTO_MODE_PRIORITY if mode in self.valid_modes and mode != "auto"
        ] or ["groq", "claude", "hf_api", "local"]
        self._initialized_modes = set()

        # WarmupError equivalent — provider init failure surfaced to the
        # UI's "last_error" row. Kept as a dict so the warmup router can
        # format `[init:<mode>] <message>` without re-deriving the mode.
        # Cleared only when the same mode subsequently inits cleanly, so a
        # fallback success does NOT silently hide a swallowed explicit
        # provider failure (matches Codex review's "be careful clearing").
        self._last_init_error: Optional[dict] = None

        self._model = None
        self._tok = None
        self._torch = None
        self._hf_client = None
        self._claude = None
        self._groq = None

        # 실제 provider 초기화는 첫 /chat 요청 또는 /warmup 시 `ensure_mode`가 수행.
        # 예전엔 여기서 바로 초기화해서 local 모드일 때 서버 기동이 블로킹되고
        # 모드 전환이 빈번한 경우에도 import 시점에 불필요한 비용을 냈다.
        #
        # 동시 첫 호출(예: 프론트 시작 직후 /warmup + 사용자 첫 /chat) 시 같은
        # mutable provider state(_model, _initialized_modes, self.mode)를 두 코루틴이
        # 동시에 만지지 않게 _init_lock으로 직렬화한다. 첫 init 이후엔
        # _initialized_modes 캐시가 fast-path를 만들어 lock acquire 비용만 낸다.
        self._init_lock = asyncio.Lock()

    def _module_available(self, module_name: str) -> bool:
        return importlib.util.find_spec(module_name) is not None

    def _mode_has_prereqs(self, mode: str) -> bool:
        if mode == "local":
            return self._module_available("torch") and self._module_available("transformers")
        if mode == "hf_api":
            return self._module_available("huggingface_hub") and bool(HF_TOKEN)
        if mode == "claude":
            return self._module_available("anthropic") and bool(ANTHROPIC_KEY)
        if mode == "groq":
            return self._module_available("groq") and bool(GROQ_KEY)
        return False

    def _get_auto_candidates(self) -> List[str]:
        return [mode for mode in self.auto_mode_priority if self._mode_has_prereqs(mode)]

    def _select_auto_mode(self) -> str:
        candidates = self._get_auto_candidates()
        if candidates:
            return candidates[0]
        return "fallback"

    def _normalize_mode(self, requested_mode: Optional[str]) -> str:
        if requested_mode in self.valid_modes:
            return requested_mode
        if self.default_mode in self.valid_modes:
            return self.default_mode
        return "auto"

    def _normalize_memory_turns(self, memory_turns: Optional[int]) -> int:
        if not isinstance(memory_turns, int):
            return DEFAULT_MEMORY_TURNS
        return max(1, min(memory_turns, 50))

    def _trim_history(self, history: List[Any], memory_turns: Optional[int]) -> List[Any]:
        limit = self._normalize_memory_turns(memory_turns) * 2
        return history[-limit:]

    def _history_item_to_message(self, item: Any) -> dict:
        if isinstance(item, dict):
            role = item.get("role", "user")
            content = item.get("content", "")
        else:
            role = getattr(item, "role", "user")
            content = getattr(item, "content", "")

        return {"role": role, "content": content}

    def _build_messages(self, history: List[Any], memory_turns: Optional[int]) -> List[dict]:
        return [
            self._history_item_to_message(item)
            for item in self._trim_history(history, memory_turns)
        ]

    def _initialize_mode(self, mode: str) -> bool:
        self.mode = mode

        if mode == "local":
            self._init_local()
        elif mode == "hf_api":
            self._init_hf_api()
        elif mode == "claude":
            self._init_claude()
        elif mode == "groq":
            self._init_groq()
        else:
            self.mode = "fallback"

        if self.mode == mode:
            self._initialized_modes.add(mode)
            return True

        return False

    async def ensure_mode(self, requested_mode: Optional[str]) -> str:
        """Public 진입점. `chat()`과 `routers.warmup` 모두 이걸 통해 들어온다.

        `_ensure_mode`는 동기이고 안에서 `_initialize_mode` → `_init_local`이
        HF 모델 로딩 같은 무거운 IO/CPU 작업을 한다. await 가능한 thread로
        떼어내 이벤트 루프가 다른 요청을 처리할 수 있게 하고, 동시 호출의
        race(`_model`, `_initialized_modes`, `self.mode`)를 `_init_lock`으로
        직렬화한다. 두 번째 호출부터는 lock 안에서 `_initialized_modes` 캐시가
        fast-path를 만들어 to_thread 비용도 거의 없다.
        """
        async with self._init_lock:
            return await asyncio.to_thread(self._ensure_mode, requested_mode)

    def is_mode_initialized(self, mode: str) -> bool:
        """`routers.warmup`가 readiness 판단 시 사용. private set을 그대로 노출하지
        않으면서 캐시 hit을 캐시 hit으로 알 수 있게 한다."""
        return mode in self._initialized_modes

    def list_initialized_modes(self) -> List[str]:
        """초기화된 mode들을 정렬된 list로 반환 (GET /warmup 응답용)."""
        return sorted(self._initialized_modes)

    def select_auto_mode(self) -> str:
        """현재 priority 기준으로 후보 mode 1개를 반환 (없으면 'fallback')."""
        return self._select_auto_mode()

    def list_available_modes(self) -> List[str]:
        """현재 환경에서 *사용 가능한* mode 목록 (env 키 + 의존 라이브러리 둘 다 통과한
        것). settings UI가 "auto가 왜 fallback이 됐는지"를 사용자에게 설명하려면
        is_mode_initialized(이미 init된 것)만으론 부족하다 — init은 아직 안 했지만
        prereqs는 충족된 모드도 후보로 보여줘야 한다.

        AUTO_MODE_PRIORITY 필터를 안 거치는 게 의도적: priority는 auto의 *선택* 기준
        이지 "사용 가능한 provider 목록"이 아니다. priority에서 빠진 mode도 사용자가
        명시 선택하면 동작하므로 UI엔 둘 다 보여야 한다."""
        return sorted([
            mode for mode in self.valid_modes
            if mode != "auto" and self._mode_has_prereqs(mode)
        ])

    def resolve_auto_target(self) -> Optional[str]:
        """Auto mode가 *지금* 고를 mode를 priority 순서로 반환. 없으면 None.

        list_available_modes는 알파벳 정렬이라 priority와 다를 수 있다 — UI가
        '지금 선택하면 어디로 갈지'를 보여주려면 priority 순서가 필요하다.
        candidates 비어있으면 None (fallback이라 명시 — 'fallback'을 mode
        문자열로 노출하지 않는 게 invariant)."""
        candidates = self._get_auto_candidates()
        return candidates[0] if candidates else None

    def get_last_init_error(self) -> Optional[dict]:
        """Provider init이 실패해 fallback으로 넘어간 마지막 사건. UI의 last_error
        행에 표시할 정보. 같은 mode가 성공적으로 init되면 자동 clear."""
        return self._last_init_error

    def _record_init_error(self, mode: str, error: BaseException) -> None:
        self._last_init_error = {
            "mode": mode,
            "message": f"{type(error).__name__}: {error}"
        }

    def _clear_init_error_if_recovered(self, mode: str) -> None:
        """같은 mode가 성공 init되면 stale error 비움. fallback success가 다른
        mode의 명시 실패를 가리지 않게 정확히 *같은* mode일 때만."""
        if self._last_init_error and self._last_init_error.get("mode") == mode:
            self._last_init_error = None

    def _ensure_mode(self, requested_mode: Optional[str]) -> str:
        normalized_mode = self._normalize_mode(requested_mode)
        requested_explicit_mode = normalized_mode if normalized_mode != "auto" else None

        target_mode = (
            self._select_auto_mode()
            if normalized_mode == "auto"
            else normalized_mode
        )

        if target_mode == "fallback":
            self.mode = "fallback"
            return self.mode

        if target_mode in self._initialized_modes:
            self.mode = target_mode
            return self.mode

        if self._initialize_mode(target_mode):
            return self.mode

        fallback_mode = self._select_auto_mode()
        if (
            requested_explicit_mode is not None
            and fallback_mode not in ("fallback", target_mode)
        ):
            print(
                f"[AI] requested mode '{requested_explicit_mode}' unavailable; "
                f"falling back to '{fallback_mode}'"
            )
            if fallback_mode in self._initialized_modes:
                self.mode = fallback_mode
                return self.mode
            if self._initialize_mode(fallback_mode):
                return self.mode

        self.mode = "fallback"
        return self.mode

    def _build_unavailable_reply(self, requested_mode: Optional[str]) -> str:
        available_modes = self._get_auto_candidates()
        available_label = ", ".join(available_modes) if available_modes else "none"

        if requested_mode and requested_mode != "auto":
            prefix = f"The selected AI mode '{requested_mode}' is unavailable right now."
        else:
            prefix = "No AI provider is available right now."

        guidance = (
            "Set APIA_GROQ_KEY, APIA_ANTHROPIC_KEY, or APIA_HF_TOKEN in environment variables or backend.env, "
            "or run a full local build with torch and transformers."
        )

        return f"{prefix} Available auto modes: {available_label}. {guidance} [EMOTION:sad]"

    def _init_local(self):
        try:
            import torch
            from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

            print(f"[AI] local cuda_available={torch.cuda.is_available()}")

            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4"
            )

            self._tok = AutoTokenizer.from_pretrained(MODEL_ID)
            self._model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID,
                quantization_config=bnb_config,
                device_map="auto",
                low_cpu_mem_usage=True
            )
            self._model.eval()
            self._torch = torch
            self._clear_init_error_if_recovered("local")
            print("[AI] local model initialized")
        except ImportError as error:
            print(f"[AI] local import error: {error}")
            self._record_init_error("local", error)
            self.mode = "fallback"
        except Exception as error:
            print(f"[AI] local init failed: {type(error).__name__}: {error}")
            self._record_init_error("local", error)
            self.mode = "fallback"

    def _init_hf_api(self):
        try:
            from huggingface_hub import InferenceClient

            self._hf_client = InferenceClient(model=MODEL_ID, token=HF_TOKEN or None)
            self._clear_init_error_if_recovered("hf_api")
            print("[AI] hf_api initialized")
        except ImportError as error:
            print(f"[AI] hf_api import error: {error}")
            self._record_init_error("hf_api", error)
            self.mode = "fallback"
        except Exception as error:
            print(f"[AI] hf_api init failed: {type(error).__name__}: {error}")
            self._record_init_error("hf_api", error)
            self.mode = "fallback"

    def _init_claude(self):
        try:
            import anthropic

            self._claude = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
            self._clear_init_error_if_recovered("claude")
            print("[AI] claude initialized")
        except ImportError as error:
            print(f"[AI] claude import error: {error}")
            self._record_init_error("claude", error)
            self.mode = "fallback"
        except Exception as error:
            print(f"[AI] claude init failed: {type(error).__name__}: {error}")
            self._record_init_error("claude", error)
            self.mode = "fallback"

    def _init_groq(self):
        try:
            from groq import Groq

            self._groq = Groq(api_key=GROQ_KEY)
            self._clear_init_error_if_recovered("groq")
            print("[AI] groq initialized")
        except ImportError as error:
            print(f"[AI] groq import error: {error}")
            self._record_init_error("groq", error)
            self.mode = "fallback"
        except Exception as error:
            print(f"[AI] groq init failed: {type(error).__name__}: {error}")
            self._record_init_error("groq", error)
            self.mode = "fallback"

    # 고정 section 순서(Codex NICE-TO-HAVE 3단계 round 1). dict 삽입순서에
    # 기대지 않고 항상 같은 순서로 직렬화 → 테스트와 프롬프트 안정성.
    _CONTEXT_SECTION_ORDER = ("기억", "파일", "웹")
    _CONTEXT_SECTION_HINT = {
        "기억": "참고할 기억(과거 대화/요약). 사용자가 명시적으로 묻지 않으면 굳이 끄집어내지 말 것",
        "파일": "참고할 파일 내용. 사용자가 직접 관련 질문을 한 경우에만 인용",
        "웹": "참고할 웹 검색 결과",
    }

    def _build_system_prompt(self, context_blocks: Optional[dict] = None) -> str:
        """SYSTEM_PROMPT + (있으면) 컨텍스트 섹션들을 한 덩어리로 합친다.

        Codex MUST-FIX (2단계): history에 `role='system'` 메시지를 끼우면
        Anthropic API의 `system=...` 별도 슬롯과 충돌하므로, 모든 컨텍스트는
        시스템 프롬프트의 뒤쪽 섹션으로 덧붙인다.
        Codex MUST-FIX (3단계 round 1): context_blocks dict로 일반화 +
        고정 section order. 알려지지 않은 key가 들어와도 마지막에 알파벳순으로
        붙여 forward-compatible.
        """
        if not context_blocks:
            return SYSTEM_PROMPT
        # dict 삽입순서 무시. 알려진 순서 먼저, 알려지지 않은 key는 뒤로.
        known = [k for k in self._CONTEXT_SECTION_ORDER if context_blocks.get(k)]
        unknown = sorted(
            k for k in context_blocks
            if k not in self._CONTEXT_SECTION_ORDER and context_blocks.get(k)
        )
        sections = []
        for key in known + unknown:
            body = context_blocks[key].strip()
            if not body:
                continue
            hint = self._CONTEXT_SECTION_HINT.get(key, key)
            sections.append(f"## {hint}\n{body}")
        if not sections:
            return SYSTEM_PROMPT
        return f"{SYSTEM_PROMPT}\n\n---\n" + "\n\n".join(sections) + "\n"

    @staticmethod
    def _coerce_context_blocks(
        context_blocks: Optional[dict],
        memory_context: Optional[str],
    ) -> Optional[dict]:
        """memory_context (2단계 시그니처) 호환 어댑터. Codex MUST-FIX round 1:
        memory_context가 들어오면 {"기억": memory_context}로 정규화."""
        if context_blocks is not None:
            return context_blocks
        if memory_context:
            return {"기억": memory_context}
        return None

    async def chat(
        self,
        message: str,
        history: List[Any],
        ai_mode: Optional[str] = None,
        memory_turns: Optional[int] = None,
        memory_context: Optional[str] = None,
        context_blocks: Optional[dict] = None,
    ) -> Tuple[str, str]:
        requested_mode = self._normalize_mode(ai_mode)
        active_mode = await self.ensure_mode(ai_mode)
        blocks = self._coerce_context_blocks(context_blocks, memory_context)

        if active_mode == "local":
            reply = await self._chat_local(message, history, memory_turns, blocks)
        elif active_mode == "hf_api":
            reply = await self._chat_hf_api(message, history, memory_turns, blocks)
        elif active_mode == "claude":
            reply = await self._chat_claude(message, history, memory_turns, blocks)
        elif active_mode == "groq":
            reply = await self._chat_groq(message, history, memory_turns, blocks)
        else:
            reply = self._build_unavailable_reply(requested_mode)

        return self._parse_emotion(reply)

    async def summarize(self, text: str, ai_mode: Optional[str] = None) -> str:
        """장기 기억용 요약 전용 호출.

        Codex MUST-FIX: `chat()`은 emotion 태그 강제, fallback 안내문, 캐릭터
        롤플레이가 섞여 있어 요약에 못 쓴다. 여기선 별도 system prompt로
        plain text 한 덩어리만 받는다. emotion 파싱 없음, 폴백 안내문 없음.

        provider가 없으면 `RuntimeError`를 raise한다 — 호출자(MemoryService)가
        이걸 잡아서 last_error에 기록하고 요약 자체를 비활성화 처리.
        """
        active_mode = await self.ensure_mode(ai_mode)
        if active_mode == "fallback":
            raise RuntimeError(
                "no provider available for summarization (check APIA_AI_MODE / API keys)"
            )

        summary_system = (
            "You are a concise note-taker. Summarize the following Korean+English "
            "chat transcript in 3-5 short Korean sentences. Capture: who/what/when "
            "topics, decisions, and any commitments. Do NOT add emojis, emotion "
            "tags, or fictional details. Output ONLY the summary text."
        )
        user_payload = f"대화 원문:\n{text}\n\n요약:"

        if active_mode == "claude":
            return await self._summarize_claude(summary_system, user_payload)
        if active_mode == "groq":
            return await self._summarize_groq(summary_system, user_payload)
        if active_mode == "hf_api":
            return await self._summarize_hf_api(summary_system, user_payload)
        if active_mode == "local":
            return await self._summarize_local(summary_system, user_payload)
        raise RuntimeError(f"unsupported mode for summarization: {active_mode}")

    # J단계 — 행동 디렉터. 채팅과 분리된 경량 단발 호출(캐릭터 롤플레이·감정태그
    # 없음). summarize와 같은 generic (system, user) 헬퍼를 재사용한다. 출력은
    # 엄격 JSON 1개; 클라이언트(behaviorDirector.parseDirective)가 검증·clamp·
    # 폴백을 전담하므로 여기선 raw 문자열만 돌려준다.
    DIRECTOR_SYSTEM = (
        "You set the ambient mood of a small character that lives on the user's "
        "desktop. From the given context, output ONLY a compact JSON object (no "
        "prose, no markdown) describing how it should behave for the next few "
        "minutes. Schema: {\"mood\": one of "
        "[\"playful\",\"focused\",\"calm\",\"restless\",\"sleepy\"], \"focus\": one "
        "of [\"user\",\"room\",\"self\"], \"activityBias\": number -1 (settle, "
        "still) to 1 (roam, explore), \"ttlSec\": integer 120-600, \"note\": short "
        "string under 80 chars}. Guidance: late night -> sleepy/calm and low "
        "activity; morning -> livelier; just talked (high attentiveness) -> "
        "focus the user, lower activity; long idle -> more independent, higher "
        "activity. `presence` is PHYSICAL: 'active'/'short-idle' means the user "
        "is at the computer, 'away' (with awayMinutes) means they left the desk "
        "— absence, NOT disinterest. When away, prefer focus 'room' or 'self' "
        "and self-directed living; do not read it as the user ignoring the "
        "character (attentiveness alone covers engagement while present). "
        "Match the character's personality. Output ONLY the JSON."
    )

    async def decide_directive(
        self, context: Optional[dict] = None, ai_mode: Optional[str] = None
    ) -> str:
        active_mode = await self.ensure_mode(ai_mode)
        if active_mode == "fallback":
            raise RuntimeError(
                "no provider available for director (check APIA_AI_MODE / API keys)"
            )
        payload = "Context: " + json.dumps(context or {}, ensure_ascii=False) + "\nJSON:"
        if active_mode == "claude":
            return await self._summarize_claude(self.DIRECTOR_SYSTEM, payload)
        if active_mode == "groq":
            return await self._summarize_groq(self.DIRECTOR_SYSTEM, payload)
        if active_mode == "hf_api":
            return await self._summarize_hf_api(self.DIRECTOR_SYSTEM, payload)
        if active_mode == "local":
            return await self._summarize_local(self.DIRECTOR_SYSTEM, payload)
        raise RuntimeError(f"unsupported mode for director: {active_mode}")

    async def _summarize_claude(self, system: str, user: str) -> str:
        try:
            response = self._claude.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=MAX_NEW_TOKENS,
                temperature=0.2,  # 요약·디렉터 모두 결정성 우선(다른 provider와 일치)
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text.strip()
        except Exception as error:
            raise RuntimeError(f"claude summarize failed: {error}") from error

    async def _summarize_groq(self, system: str, user: str) -> str:
        def _call():
            response = self._groq.chat.completions.create(
                model=GROQ_MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                max_tokens=MAX_NEW_TOKENS,
                temperature=0.2,
            )
            return response.choices[0].message.content.strip()

        try:
            return await asyncio.to_thread(_call)
        except Exception as error:
            raise RuntimeError(f"groq summarize failed: {error}") from error

    async def _summarize_hf_api(self, system: str, user: str) -> str:
        def _call():
            response = self._hf_client.chat_completion(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                max_tokens=MAX_NEW_TOKENS,
                temperature=0.2,
            )
            return response.choices[0].message.content.strip()

        try:
            return await asyncio.to_thread(_call)
        except Exception as error:
            raise RuntimeError(f"hf_api summarize failed: {error}") from error

    async def _summarize_local(self, system: str, user: str) -> str:
        def _infer():
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
            text = self._tok.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            inputs = self._tok(text, return_tensors="pt").to("cuda")
            input_ids = inputs["input_ids"]
            with self._torch.no_grad():
                output = self._model.generate(
                    input_ids,
                    max_new_tokens=MAX_NEW_TOKENS,
                    temperature=0.2,
                    top_p=TOP_P,
                    do_sample=True,
                    pad_token_id=self._tok.eos_token_id,
                    eos_token_id=self._tok.eos_token_id,
                )
            generated = output[0][input_ids.shape[-1]:]
            return self._tok.decode(generated, skip_special_tokens=True).strip()

        try:
            return await asyncio.to_thread(_infer)
        except Exception as error:
            raise RuntimeError(f"local summarize failed: {error}") from error

    async def _chat_local(
        self,
        message: str,
        history: List[Any],
        memory_turns: Optional[int],
        context_blocks: Optional[dict] = None,
    ) -> str:
        import asyncio

        system_prompt = self._build_system_prompt(context_blocks)

        def _infer():
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend(self._build_messages(history, memory_turns))
            messages.append({"role": "user", "content": message})

            text = self._tok.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
            inputs = self._tok(text, return_tensors="pt").to("cuda")
            input_ids = inputs["input_ids"]

            with self._torch.no_grad():
                output = self._model.generate(
                    input_ids,
                    max_new_tokens=MAX_NEW_TOKENS,
                    temperature=TEMPERATURE,
                    top_p=TOP_P,
                    do_sample=True,
                    pad_token_id=self._tok.eos_token_id,
                    eos_token_id=self._tok.eos_token_id,
                )

            generated = output[0][input_ids.shape[-1]:]
            return self._tok.decode(generated, skip_special_tokens=True)

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _infer)
        except Exception as error:
            print(f"[AI] local inference error: {error}")
            return "I hit a local inference error. [EMOTION:sad]"

    async def _chat_hf_api(
        self,
        message: str,
        history: List[Any],
        memory_turns: Optional[int],
        context_blocks: Optional[dict] = None,
    ) -> str:
        import asyncio

        system_prompt = self._build_system_prompt(context_blocks)

        def _call():
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend(self._build_messages(history, memory_turns))
            messages.append({"role": "user", "content": message})
            response = self._hf_client.chat_completion(
                messages=messages,
                max_tokens=MAX_NEW_TOKENS,
                temperature=TEMPERATURE
            )
            return response.choices[0].message.content

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _call)
        except Exception as error:
            return f"HuggingFace API error: {str(error)[:80]} [EMOTION:sad]"

    async def _chat_claude(
        self,
        message: str,
        history: List[Any],
        memory_turns: Optional[int],
        context_blocks: Optional[dict] = None,
    ) -> str:
        try:
            messages = self._build_messages(history, memory_turns)
            messages.append({"role": "user", "content": message})
            response = self._claude.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=MAX_NEW_TOKENS,
                system=self._build_system_prompt(context_blocks),
                messages=messages
            )
            return response.content[0].text
        except Exception as error:
            return f"Claude API error: {str(error)[:80]} [EMOTION:sad]"

    async def _chat_groq(
        self,
        message: str,
        history: List[Any],
        memory_turns: Optional[int],
        context_blocks: Optional[dict] = None,
    ) -> str:
        import asyncio

        system_prompt = self._build_system_prompt(context_blocks)

        def _call():
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend(self._build_messages(history, memory_turns))
            messages.append({"role": "user", "content": message})
            response = self._groq.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages,
                max_tokens=MAX_NEW_TOKENS,
                temperature=TEMPERATURE,
            )
            return response.choices[0].message.content

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _call)
        except Exception as error:
            return f"Groq API error: {str(error)[:80]} [EMOTION:sad]"

    def _parse_emotion(self, text: str) -> Tuple[str, str]:
        emotion = "neutral"
        match = re.search(r"\[EMOTION:(\w+)\]", text)
        if match:
            emotion = match.group(1)
            text = re.sub(r"\s*\[EMOTION:\w+\]", "", text).strip()
        return text, emotion
