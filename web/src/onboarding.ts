// First-run settings and replay are available before the user has a model or has given consent.
import { languages } from "./onboarding-text.ts";

const messagesFor = (lang: string) => languages[lang] ?? languages.ko ?? {};

/**
 * data-onboarding 이름표가 붙은 글 하나: 그 언어 문구, 없으면 화면에 적힌 한국어 원문.
 * 동의 화면은 대화 언어로, 이용 설정은 설정 창에서 고른 언어로 바꾼다.
 */
export function onboardingText(lang: string, key: string, original: string) {
  return messagesFor(lang)[key] ?? original;
}

/** 키 입력란 아래 안내(저장된 키 있음·비어 있음·읽기 실패). */
export function keyHint(lang: string, keyState: string | undefined) {
  return keyState === undefined ? "" : messagesFor(lang)[keyState] ?? "";
}

/** 저장 단추: 이미 대화가 있으면 '저장하고 대화 계속하기'. */
export function saveLabel(lang: string, continuing: boolean) {
  const messages = messagesFor(lang);
  return (continuing ? messages.resume : messages.save) ?? "";
}

export interface GuideVoice { stt: boolean; tts: boolean; edge?: string | undefined; llmRoles: Readonly<Record<string, string | null>> }

export function fullGuide(lang: string, voice: GuideVoice, background: boolean, modifier: string, awaitingConsent = true) {
  const t = languages[lang];
  if (t?.guide === undefined || t.guide.length === 0) return "";
  const providers = [...new Set(["understand", "goal", "web"].map(role => voice.llmRoles[role])
    .filter((name): name is string => name !== undefined && name !== null && name.length > 0 && !/^(rules|mock)/i.test(name)))];
  return [t.guide, voice.llmRoles.vision !== "disabled" && t.image, t.files,
    voice.stt || voice.tts ? t.keyed : t.typed, voice.edge !== undefined && voice.edge.length > 0 && t.liveHistory,
    providers.length > 0 ? `${t.model ?? ""} (${providers.join(", ")}).` : t.local,
    t.stop, awaitingConsent && (background ? t.background?.replace("{key}", modifier) : t.keyboard)]
    .filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}
