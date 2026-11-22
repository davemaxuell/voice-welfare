"""프로세스 단위 조립: 브라우저 1개를 공유하고 세션마다 격리된 컨텍스트를 만든다."""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Literal, Mapping

from playwright.async_api import Browser, BrowserContext

from cheongeum.agents.web import WebExecutionAgent, create_mock_welfare_profile, field_vocabulary
from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, launch_browser, launch_chrome_profile
from cheongeum.agents.welfare import WelfareInformationAgent
from cheongeum.agents.welfare.data import create_welfare_data_provider
from cheongeum.agents.welfare.open_data import OpenData
from cheongeum.core.events import InMemoryEventLog
from cheongeum.core.jsutil import parse_url
from cheongeum.core.llm import OPENAI_BASE_URL, LlmConfig, ModelConnections, create_structured_llm, create_vision_llm, overlay_llm
from cheongeum.core.model_stack import STACK, EmbeddingService, ModerationService
from cheongeum.orchestrator import OrchestratorDeps, SessionOrchestrator
from cheongeum.personal import PersonalStore
from cheongeum.personal.guardian import GuardianSender, PreviewSender, guardian_sender
from cheongeum.safety import PolicyConfig, PolicyGuard, set_pii_model
from cheongeum.safety.pii_model import PiiModel
from cheongeum.understanding import create_intent_provider
from cheongeum.voice import VoiceConfig, create_voice_providers
from cheongeum.voice.config import DEFAULT_SPEED
from cheongeum.server.settings import SettingsStore
from cheongeum.server.public_search import TavilySearch

log = logging.getLogger("cheongeum.runtime")
DEFAULT_OPENAI_MODEL = STACK.agent
DEFAULT_PUBLIC_MODEL = STACK.agent


@dataclass
class RuntimeConfig:
    mockSiteUrl: str
    extraAllowedOrigins: list[str]
    headless: bool
    slowMoMs: int
    # 시작 동의 전에는 화면을 읽거나 조작하지 않음
    requireConsent: bool
    # 연습(모의) 사이트를 기본으로 쓸지. False = 실제 사이트 모드
    practiceMode: bool
    # 지원 사이트 외 모든 웹사이트를 읽기 전용으로 열 수 있음
    readOnlyWeb: bool
    readOnlyClicks: Literal["any", "safe"]
    # 시연용 가상 커서
    visualCursor: bool
    # chromium = 테스트용 Chromium(세션마다 격리), chrome = 설치된 Google Chrome + 영구 프로필(로그인 유지)
    browserMode: str
    chromeProfileDir: str
    llm: LlmConfig
    voice: VoiceConfig
    guardianSender: GuardianSender | None = field(default_factory=PreviewSender)
    welfareApiKey: str | None = None
    welfareApiBaseUrl: str | None = None
    datasetsDir: str | None = None
    # 금고·신청 기록을 둘 폴더(없으면 대화 메모리에만). 데스크톱 앱은 ~/.cheongeum
    dataDir: str | None = None
    # 개인 PC라고 고른 사용자의 금고 폴더(CHEONGEUM_DATA_DIR). 쓸지는 AgentRuntime.personal_enabled()가 정한다.
    personalDataDir: str | None = None
    pilotProfile: Literal["personal", "shared", "unidentified"] = "unidentified"
    # 웹 검색 주소 틀({q})
    searchUrlTemplate: str | None = None
    tavilyApiKey: str | None = field(default=None, repr=False)
    # 로컬 개인정보 인식 모델 폴더(없으면 규칙만)와 판정 기준 확률
    piiModel: str | None = None
    piiThreshold: float = 0.5
    # 역할별 덮어쓰기(없으면 llm과 같음).
    llmUnderstand: LlmConfig | None = None  # 의도 계획·대화 분류
    llmGoal: LlmConfig | None = None  # 목표 수행(browse_step)
    llmWeb: LlmConfig | None = None  # 검색 답·화면 요약
    llmFile: LlmConfig | None = None
    # 화면 사진 설명. 공급자가 openai일 때만 켜진다(create_vision_llm). 사진을 얼마나 자세히 볼지는 LLM_VISION_DETAIL.
    llmVision: LlmConfig | None = None
    llmRecovery: LlmConfig | None = None
    visionDetail: Literal["low", "high", "auto"] = "high"
    publicPlanning: bool = True


# 저장소 루트(src/cheongeum/server/runtime.py → 세 단계 위). 모델 폴더 같은 상대 경로의 기준.
ROOT = Path(__file__).resolve().parents[3]


def _blank(v: str | None) -> str | None:
    return v.strip() if v and v.strip() else None


def _float(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def _path(v: str | None, root: Path) -> str | None:
    """개발용 상대 경로는 저장소, 설치본은 런타임 폴더 기준."""
    p = _blank(v)
    if not p:
        return None
    path = Path(p).expanduser()
    return str(path if path.is_absolute() else root / path)


def _vision_detail(v: str | None) -> Literal["low", "high", "auto"]:
    detail = (v or "").strip().lower()
    return detail if detail in ("low", "auto") else "high"  # type: ignore[return-value]


def _llm_role(env: Mapping[str, str], role: str, base: LlmConfig) -> LlmConfig:
    """LLM_{ROLE}_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT. 비면 base."""
    prefix = f"LLM_{role}_"
    cfg = overlay_llm(
        base,
        provider=_blank(env.get(f"{prefix}PROVIDER")),
        model=_blank(env.get(f"{prefix}MODEL")),
        base_url=_blank(env.get(f"{prefix}BASE_URL")),
        api_key=_blank(env.get(f"{prefix}API_KEY")),
        reasoning_effort=_blank(env.get(f"{prefix}REASONING_EFFORT")),
    )
    if cfg.provider != base.provider and not _blank(env.get(f"{prefix}BASE_URL")):
        cfg = replace(cfg, baseUrl=None)
    different_origin = (cfg.baseUrl or OPENAI_BASE_URL).rstrip("/") != (base.baseUrl or OPENAI_BASE_URL).rstrip("/")
    if (cfg.provider != base.provider or different_origin) and not _blank(env.get(f"{prefix}API_KEY")):
        cfg = replace(cfg, apiKey=None)
    return cfg


def load_config(env: Mapping[str, str] | None = None) -> RuntimeConfig:
    env = dict(os.environ if env is None else env)
    root = Path(env.get("CHEONGEUM_DESKTOP_RUNTIME") or ROOT)
    headless = env.get("HEADLESS") in ("true", "1")
    speed = _float(env.get("TTS_SPEED"))
    extra = [parse_url(s.strip()).origin for s in (env.get("EXTRA_ALLOWED_ORIGINS") or "").split(",") if s.strip()]
    try:
        slow_mo = int(float(env.get("BROWSER_SLOWMO_MS") or 0))
    except ValueError:
        slow_mo = 0
    openai_key = _blank(env.get("OPENAI_API_KEY"))
    voice_key = _blank(env.get("VOICE_API_KEY")) or openai_key
    official_voice = (_blank(env.get("VOICE_BASE_URL")) or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL
    official_llm_origin = (_blank(env.get("LLM_BASE_URL")) or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL
    provider = env.get("LLM_PROVIDER") or (
        "openai" if (official_llm_origin and (openai_key or _blank(env.get("LLM_API_KEY")) or (voice_key and official_voice))) else "mock"
    )
    official_llm = provider == "openai" and (_blank(env.get("LLM_BASE_URL")) or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL
    llm = LlmConfig(
        provider=provider,
        model=_blank(env.get("LLM_MODEL")) or (DEFAULT_OPENAI_MODEL if official_llm else None),
        baseUrl=_blank(env.get("LLM_BASE_URL")),
        apiKey=_blank(env.get("LLM_API_KEY")) or ((openai_key or (voice_key if official_voice else None)) if official_llm else None),
        reasoningEffort=_blank(env.get("LLM_REASONING_EFFORT")),
    )
    requested_profile = env.get("PILOT_PROFILE")
    profile = requested_profile if requested_profile in ("personal", "shared") else "unidentified"

    def role_config(role: str, default: str, effort: str) -> LlmConfig:
        cfg = _llm_role(env, role, llm)
        if cfg.provider == "openai" and (cfg.baseUrl or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL:
            override = _blank(env.get(f"LLM_{role}_MODEL"))
            if role in ("GOAL", "UNDERSTAND", "FILE"):
                override = override or _blank(env.get("LLM_MODEL"))
            if not override or override == default:
                return replace(cfg, model=default, reasoningEffort=_blank(env.get(f"LLM_{role}_REASONING_EFFORT")) or effort)
        return cfg

    return RuntimeConfig(
        pilotProfile=profile,
        mockSiteUrl=env.get("MOCK_SITE_URL") or "http://localhost:5174",
        extraAllowedOrigins=extra,
        headless=headless,
        slowMoMs=slow_mo,
        requireConsent=env.get("REQUIRE_CONSENT") != "false",
        practiceMode=env.get("PRACTICE_MODE") != "false",
        dataDir=_blank(env.get("CHEONGEUM_DATA_DIR")) if profile == "personal" else None,
        personalDataDir=_blank(env.get("CHEONGEUM_DATA_DIR")),
        browserMode="chrome" if profile == "personal" and env.get("BROWSER_MODE") == "chrome" else "chromium",
        chromeProfileDir=_blank(env.get("CHROME_PROFILE_DIR")) or str(Path.home() / ".cheongeum" / "chrome-profile"),
        readOnlyWeb=env.get("READ_ONLY_WEB") != "false",
        # 주민 시험 기본값. any는 같은 합성 시나리오로 비교할 때 명시한다.
        readOnlyClicks="any" if (env.get("READ_ONLY_CLICKS") or "").strip().lower() == "any" else "safe",
        searchUrlTemplate=_blank(env.get("WEB_SEARCH_URL")),
        tavilyApiKey=_blank(env.get("TAVILY_API_KEY")),
        visualCursor=env["VISUAL_CURSOR"] == "true" if env.get("VISUAL_CURSOR") else not headless,
        guardianSender=guardian_sender(env),
        llm=llm,
        llmUnderstand=role_config("UNDERSTAND", STACK.agent, "low"),
        llmGoal=role_config("GOAL", STACK.agent, "low"),
        publicPlanning=env.get("PUBLIC_SERVICE_ROUTER", "true").casefold() != "false",
        llmWeb=role_config("WEB", STACK.utility, "none"),
        llmFile=role_config("FILE", STACK.agent, "low"),
        llmVision=role_config("VISION", STACK.vision, "low"),
        llmRecovery=role_config("RECOVERY", STACK.recovery, "medium"),
        visionDetail=_vision_detail(env.get("LLM_VISION_DETAIL")),
        voice=VoiceConfig(
            apiKey=_blank(env.get("VOICE_API_KEY")) or ((openai_key or (llm.apiKey if official_llm else None)) if official_voice else None),
            baseUrl=_blank(env.get("VOICE_BASE_URL")) or OPENAI_BASE_URL,
            sttModel=_blank(env.get("STT_MODEL")) or VoiceConfig.sttModel,
            ttsModel=_blank(env.get("TTS_MODEL")) or VoiceConfig.ttsModel,
            ttsVoice=_blank(env.get("TTS_VOICE")) or VoiceConfig.ttsVoice,
            liveModel=_blank(env.get("VOICE_LIVE_MODEL")) or STACK.voice,
            ttsInstructions=_blank(env.get("TTS_INSTRUCTIONS")) or VoiceConfig.ttsInstructions,
            ttsSpeed=min(4.0, max(0.25, speed)) if speed and speed > 0 else DEFAULT_SPEED,
        ),
        welfareApiKey=_blank(env.get("WELFARE_API_KEY")) if env.get("WELFARE_DATA_MODE") == "official-api" else None,
        welfareApiBaseUrl=_blank(env.get("WELFARE_API_BASE_URL")),
        datasetsDir=_path(env.get("DATASETS_DIR"), root),
        piiModel=_path(env.get("PII_MODEL"), root),
        piiThreshold=_float(env.get("PII_THRESHOLD")) or 0.5,
    )


def _load_pii_model(config: RuntimeConfig) -> PiiModel | None:
    """PII_MODEL이 있으면 개인정보 인식 모델을 켠다(민감정보 판정 = 규칙 ∪ 모델). 없거나 실패하면 규칙만."""
    if not config.piiModel:
        set_pii_model(None)
        return None
    if not PiiModel.available(config.piiModel):
        log.error("[privacy] PII_MODEL=%s 에 모델이 없습니다. uv run python scripts/setup_local_models.py 를 실행하세요 → 규칙만 사용", config.piiModel)
        set_pii_model(None)
        return None
    model = PiiModel(config.piiModel, threshold=config.piiThreshold)
    try:
        model.load()
    except Exception as e:  # noqa: BLE001
        log.error("[privacy] 개인정보 인식 모델을 불러오지 못했습니다(%s) → 규칙만 사용", type(e).__name__)
        set_pii_model(None)
        return None
    set_pii_model(model)
    return model


class AgentRuntime:
    """프로세스 단위 조립: 브라우저 1개를 공유하고 세션마다 격리된 컨텍스트를 만든다."""

    def __init__(self, config: RuntimeConfig, settings: SettingsStore | None = None) -> None:
        self.config = config
        self.settings = settings
        self.profile = create_mock_welfare_profile(config.mockSiteUrl)
        self.welfare_provider = create_welfare_data_provider(api_key=config.welfareApiKey, api_base_url=config.welfareApiBaseUrl)
        self.open_data = OpenData.load(config.datasetsDir)
        self.connections = ModelConnections()
        self.refresh_services()
        self.events = InMemoryEventLog()
        self.pii_model = _load_pii_model(config)
        self._personal: PersonalStore | None = None
        self._action_log = None
        self._seal = None
        self._browser: asyncio.Task[Browser] | None = None
        self._worker_browser: asyncio.Task[Browser] | None = None
        self._chrome: asyncio.Task[BrowserContext] | None = None
        # 봉인 키를 만드는 함수(없으면 OS keyring의 Seal). 시험은 고정 키를 넣는다.
        self.seal_factory = None
        # 평소 쓰는 크롬을 열지 못해 따로 쓰는 브라우저로 바꿨는지(설정 화면이 알려 준다)
        self.browser_fallback = False

    def personal_enabled(self) -> bool:
        """개인 정보를 이 PC에 둘지: 개인 프로필로 띄웠거나, 공용 프로필이 아니고 사용자가 '나만 쓰는 개인 PC'를 골랐을 때."""
        if self.config.pilotProfile == "personal":
            return True
        s = self.settings
        return bool(self.config.pilotProfile != "shared" and s and s.completed and s.preferences.deviceUse == "personal")

    def _get_seal(self):
        if self._seal is None:
            from cheongeum.personal.seal import Seal

            # 폴더가 있으면 반드시 봉인한다. keyring 실패 때 평문으로 떨어지지 않는다(주인 결정).
            self._seal = (self.seal_factory or Seal)()
        return self._seal

    def personal_store(self) -> PersonalStore | None:
        """개인 PC면 금고(폴더가 있으면 봉인한 파일, 없으면 이 프로세스 메모리). 아니면 None이고 열어 둔 것도 놓는다."""
        if not self.personal_enabled():
            self._personal = None
            return None
        if self._personal is None:
            folder = self.config.dataDir or self.config.personalDataDir
            self._personal = PersonalStore(str(Path(folder) / "personal.json"), seal=self._get_seal()) if folder else PersonalStore()
        return self._personal

    def browser_mode(self) -> str:
        """chrome = 평소 쓰는 크롬(로그인 유지)은 개인 PC에서만. 그 밖에는 따로 쓰는 Chromium."""
        s = self.settings
        chosen = self.config.browserMode == "chrome" or bool(s and s.completed and s.preferences.browser == "chrome")
        return "chrome" if chosen and self.personal_enabled() else "chromium"

    def refresh_services(self) -> None:
        config = self.config
        voice = config.voice
        if self.settings and self.settings.completed:
            voice = replace(voice, ttsSpeed=self.settings.preferences.speed)
            if self.settings.key:
                # 화면에서 등록한 OpenAI 키는 이전 설정의 다른 API 주소에 전달하지 않는다.
                key = self.settings.key
                voice_defaults = voice if voice.baseUrl.rstrip("/") == OPENAI_BASE_URL else VoiceConfig()
                voice = replace(voice_defaults, apiKey=key, ttsSpeed=voice.ttsSpeed)

                def with_key(role: LlmConfig | None, default: str = DEFAULT_OPENAI_MODEL) -> LlmConfig:
                    role = role or config.llm
                    if role.provider == "openai" and (role.baseUrl or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL:
                        return replace(role, apiKey=key, model=role.model or default)
                    if create_structured_llm(role) is not None:
                        return role  # 별도로 구성한 공급자는 그 공급자의 설정과 자격 증명을 유지한다.
                    effort = {STACK.utility: "none", STACK.recovery: "medium", STACK.agent: "low", STACK.vision: "low"}
                    return LlmConfig(provider="openai", model=default, apiKey=key, reasoningEffort=effort.get(default))

                config = replace(config, llm=with_key(config.llm), llmUnderstand=with_key(config.llmUnderstand, DEFAULT_PUBLIC_MODEL),
                                 llmGoal=with_key(config.llmGoal, DEFAULT_PUBLIC_MODEL), llmWeb=with_key(config.llmWeb, STACK.utility),
                                 llmFile=with_key(config.llmFile), llmVision=with_key(config.llmVision, STACK.vision),
                                 llmRecovery=with_key(config.llmRecovery, STACK.recovery))
        self.voice_config = voice
        official_key = self.settings.key if self.settings and self.settings.completed else None
        if not official_key and config.llm.provider == "openai" and (config.llm.baseUrl or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL:
            official_key = config.llm.apiKey
        if not official_key and voice.baseUrl.rstrip("/") == OPENAI_BASE_URL:
            official_key = voice.apiKey
        self.embedding = EmbeddingService(official_key, STACK.embedding, self.connections) if official_key else None
        self.moderation = ModerationService(official_key, STACK.moderation, self.connections) if official_key else None
        self.stt, self.tts = create_voice_providers(voice)
        self.default_llm = config.llm
        understand_cfg = config.llmUnderstand or config.llm
        self.intent_provider = create_intent_provider(understand_cfg, field_vocabulary(self.profile))
        # 근거 기반 답변·검색 요약(없으면 주제 규칙 답변). 목표 수행은 goal_llm.
        self.answer_llm = create_structured_llm(config.llmWeb or config.llm, pool=self.connections)
        self.understand_llm = create_structured_llm(understand_cfg, pool=self.connections)
        self.goal_llm = create_structured_llm(config.llmGoal or config.llm, pool=self.connections)
        self.recovery_llm = create_structured_llm(config.llmRecovery, pool=self.connections) if config.llmRecovery else None
        file_cfg = config.llmFile or config.llm
        self.file_llm = create_structured_llm(replace(file_cfg, timeoutMs=120_000), pool=self.connections) if file_cfg.provider.lower() == "openai" else None
        # 화면 사진을 보는 모델. None이면 사진 기능이 없다.
        self.vision_llm = create_vision_llm(config.llmVision or config.llm, detail=config.visionDetail, pool=self.connections)

    def llm_roles(self) -> dict:
        """역할별 공급자 이름(동의 안내·/api/health)."""

        def name(llm, fallback: str) -> str:
            return llm.name if llm else fallback

        base = name(create_structured_llm(self.default_llm), self.intent_provider.name)
        return {
            "default": name(create_structured_llm(self.default_llm), "rules"),
            "understand": name(self.understand_llm, self.intent_provider.name),
            "goal": name(self.goal_llm, base),
            "web": name(self.answer_llm, base),
            "file": name(self.file_llm, "local-text"),
            "vision": name(self.vision_llm, "disabled"),
            "recovery": name(self.recovery_llm, "disabled"),
            "embeddings": self.embedding.model if self.embedding else "disabled",
            "moderation": self.moderation.model if self.moderation else "disabled",
        }

    def session_models(self) -> dict:
        return {"intent_provider": self.intent_provider, "llm": self.understand_llm or self.answer_llm,
                "goal_llm": self.goal_llm or self.answer_llm, "web_llm": self.answer_llm,
                "file_llm": self.file_llm, "vision_llm": self.vision_llm, "recovery_llm": self.recovery_llm,
                "quiet_search": TavilySearch(self.config.tavilyApiKey, self.answer_llm, self.connections)
                if self.config.tavilyApiKey else None}

    @property
    def allowed_origins(self) -> list[str]:
        return [self.profile.origin, *self.config.extraAllowedOrigins]

    async def _get_browser(self, *, background: bool = False) -> Browser:
        slot = "_worker_browser" if background and not self.config.headless else "_browser"
        launch = getattr(self, slot)
        if launch is None:
            async def open_browser() -> Browser:
                browser = await launch_browser(background or self.config.headless, 0 if background else self.config.slowMoMs)

                def disconnected(_browser) -> None:
                    if getattr(self, slot) is launch:
                        setattr(self, slot, None)

                browser.on("disconnected", disconnected)
                return browser

            launch = asyncio.create_task(open_browser())
            setattr(self, slot, launch)
        try:
            browser = await asyncio.shield(launch)
        except Exception:
            if getattr(self, slot) is launch:
                setattr(self, slot, None)
            raise
        if not browser.is_connected():
            if getattr(self, slot) is launch:
                setattr(self, slot, None)
            raise RuntimeError("브라우저 연결이 끊어졌어요. 다시 열어 주세요.")
        return browser

    async def _get_chrome(self) -> BrowserContext:
        """실제 크롬(영구 프로필)은 프로세스에 하나. 사용자가 창을 닫으면 다음 세션에서 다시 띄운다."""
        if self._chrome is None:

            async def launch() -> BrowserContext:
                ctx = await launch_chrome_profile(self.config.chromeProfileDir, self.config.slowMoMs)

                def on_close(_c) -> None:
                    if self._chrome is opening:
                        self._chrome = None

                ctx.on("close", on_close)
                return ctx

            self._chrome = asyncio.ensure_future(launch())
        opening = self._chrome
        try:
            return await asyncio.shield(opening)
        except Exception:
            if self._chrome is opening:
                self._chrome = None
            raise

    async def _session_browser(self, background: bool) -> Browser | BrowserContext:
        if not background and self.browser_mode() == "chrome":
            try:
                context = await self._get_chrome()
                self.browser_fallback = False
                return context
            except Exception as e:  # noqa: BLE001
                # 크롬이 없거나 다른 창이 프로필을 쓰고 있으면 별도 브라우저에서 연다.
                log.warning("평소 쓰는 크롬을 열지 못해 별도 브라우저로 시작(%s)", type(e).__name__)
                self.browser_fallback = True
        return await self._get_browser(background=background)

    async def create_session(self, *, background: bool = False) -> SessionOrchestrator:
        full_origins = [] if background else self.allowed_origins
        read_only_web = background or self.config.readOnlyWeb
        adapter = PlaywrightExecutionAdapter(
            browser_source=lambda: self._session_browser(background),
            allowed_origins=full_origins,
            read_only_web=read_only_web,
            visual_cursor=self.config.visualCursor and not background,
        )
        # 화면이 필요한 첫 작업에서만 창을 연다. 연습 모드는 시작 화면을 사용한다.
        if background or self.config.practiceMode or (self.config.headless and self.browser_mode() != "chrome"):
            await adapter.start()
        fields = [] if background else self.profile.fields
        guard = PolicyGuard(
            PolicyConfig(
                allowedOrigins=full_origins,
                allowedActionTypes=["navigate", "back", "click", "fill", "press", "select", "check", "read", "focus", "scroll", "capture"],
                allowedFieldIds=[f.field_id for f in fields if f.sensitivity != "secret"],
                secretFieldIds=[f.field_id for f in fields if f.sensitivity == "secret"],
                maxActionsPerTurn=32, defaultActionsPerTurn=12,
                safeButtons=[self.profile.buttons.next, self.profile.buttons.prev, *self.profile.buttons.dismiss_dialog],
                readOnlyWeb=read_only_web,
                readOnlyClicks="safe" if background else self.config.readOnlyClicks,
                publicLookupOnly=background,
            )
        )
        if not background and self._action_log is None:
            from cheongeum.personal.action_log import ActionLog

            data = Path(self.config.dataDir) if self.config.dataDir else None
            self._action_log = ActionLog(str(data / "actions.sealed"), seal=self._get_seal()) if data else ActionLog()
        personal = None if background else self.personal_store()
        from cheongeum.agents.web.downloads import DownloadStore

        if not background:
            adapter.downloads = DownloadStore(str(Path(self.config.dataDir) / "downloads") if self.config.dataDir else None)
        settings = None if background else self.settings
        remember = settings and self.config.pilotProfile != "shared"
        action_log = None if background else self._action_log
        session = SessionOrchestrator(
            OrchestratorDeps(
                **self.session_models(),
                web=WebExecutionAgent(adapter, guard, self.profile, action_log=action_log),
                welfare=WelfareInformationAgent(self.welfare_provider, self.answer_llm, shelf=self.open_data.programs, links=self.open_data.links),
                places=self.open_data.places,
                events=InMemoryEventLog() if background else self.events,
                require_consent=self.config.requireConsent and not background,
                practice_mode=self.config.practiceMode and not background,
                public_planning=self.config.publicPlanning,
                initial_region=settings.preferences.region if settings else "",
                initial_language=settings.preferences.language if settings else "ko",
                initial_service=settings.last_service if remember else None,
                remember_service=settings.remember_service if remember else None,
                first_run_step=settings.first_run if settings and settings.completed and settings.first_run != "done" else None,
                first_run_progress=settings.set_first_run if settings else None,
                personal=personal,
                guardian_sender=None if background else self.config.guardianSender,
                action_log=action_log if self.config.pilotProfile == "personal" else None,
                search_url_template=self.config.searchUrlTemplate,
            )
        )
        # 동의가 필요하면 동의 후에 첫 화면을 띄운다.
        if not background and not self.config.requireConsent:
            await session.prepare()
        return session

    async def close(self) -> None:
        await self.connections.close()
        if self._chrome is not None:
            try:
                ctx = await self._chrome
                await ctx.close()
            except Exception:  # noqa: BLE001
                pass
            self._chrome = None
        for opening in (self._browser, self._worker_browser):
            if opening is None:
                continue
            try:
                b = await opening
                await b.close()
            except Exception:  # noqa: BLE001
                pass
        self._browser = self._worker_browser = None
        # Playwright 드라이버는 프로세스에 하나라 다른 런타임이 쓸 수 있다. 끝낼 때 stop_playwright()를 따로 부른다.
