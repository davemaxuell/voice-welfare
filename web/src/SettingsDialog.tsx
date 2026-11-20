import { useEffect, useRef, useState, type FormEvent } from "react";
import { LangSchema, type Lang } from "../../src/core/turn.ts";
import type { SettingsInput } from "./api.ts";
import { closeSettings, saveSettings, type SettingsDialog as Dialog } from "./conversation.ts";
import { keyHint, onboardingText, saveLabel } from "./onboarding.ts";

const SPEEDS = [["0.85", "slow", "천천히 · 0.85배"], ["1", "normal", "보통 · 1배"], ["1.35", "fast", "빠르게 · 1.35배"], ["1.6", "faster", "더 빠르게 · 1.6배"]] as const;
const DEVICES = [["unidentified", "none", "선택 안 함"], ["personal", "personal", "나만 쓰는 개인 PC"], ["shared", "shared", "함께 쓰는 공용 PC"]] as const;
const BROWSERS = [["separate", "separate", "따로 쓰는 브라우저"], ["chrome", "chrome", "평소 쓰는 크롬 (로그인 유지)"]] as const;
const LANG_OPTIONS = [["ko", "한국어"], ["en", "English"], ["zh", "中文"], ["ja", "日本語"]] as const;

interface Form {
  apiKey: string; language: Lang; region: string; regions: string[]; speed: string; extraSpeed?: string;
  deviceUse: SettingsInput["deviceUse"]; deviceLocked: boolean; rememberService: boolean; browser: SettingsInput["browser"];
  browserFallback: boolean; autostart: boolean;
}
const EMPTY: Form = {
  apiKey: "", language: "ko", region: "", regions: [], speed: "1.35", deviceUse: "unidentified", deviceLocked: false,
  rememberService: false, browser: "separate", browserFallback: false, autostart: false,
};

/** 이용 설정 창. 글은 이 창에서 고른 언어로 바뀐다(onboarding.ts). */
export function SettingsDialog({ dialog, continuing }: { dialog: Dialog | undefined; continuing: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const open = dialog !== undefined;
  const busy = dialog === undefined || dialog.loading || dialog.saving;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => { setForm(f => ({ ...f, apiKey: "" })); }, [dialog?.seq]);

  const prefs = dialog?.prefs;
  const autostart = dialog?.autostart;
  useEffect(() => {
    if (prefs === undefined) return;
    const deviceUse = prefs.sharedDevice ? "shared" : prefs.deviceUse;
    const speed = String(prefs.speed);
    setForm(f => ({
      ...f, apiKey: "", language: prefs.language, region: prefs.region, regions: prefs.regions, speed,
      ...(SPEEDS.some(([value]) => Number(value) === prefs.speed) ? {} : { extraSpeed: speed }),
      deviceUse, deviceLocked: prefs.sharedDevice, rememberService: deviceUse === "personal" && prefs.rememberService,
      browser: prefs.browser, browserFallback: prefs.browserFallback, autostart: autostart ?? f.autostart,
    }));
    document.getElementById("setup-key")?.focus();
  }, [prefs, autostart]);

  const lang = form.language;
  const o = (key: string, original: string) => onboardingText(lang, key, original);
  const personal = form.deviceUse === "personal";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void saveSettings({
      apiKey: form.apiKey.trim(), language: form.language, region: form.region, speed: Number(form.speed), deviceUse: form.deviceUse,
      rememberService: personal && form.rememberService, browser: form.browser,
    }, autostart !== undefined ? form.autostart : undefined);
  };

  return <dialog id="settings-dialog" aria-labelledby="settings-title" ref={ref}
    onCancel={e => { if (busy) e.preventDefault(); }}
    onClose={() => { setForm(f => ({ ...f, apiKey: "" })); closeSettings(); }}>
    <form id="settings-form" onSubmit={submit}>
      <h2 id="settings-title" data-onboarding="title">{o("title", "청음 이용 설정")}</h2>
      <p data-onboarding="about">{o("about", "OpenAI API 키 하나로 받아쓰기, 음성 안내와 공공서비스 탐색을 이용할 수 있어요. 키는 이 PC에 암호화해 저장합니다.")}</p>
      <label htmlFor="setup-language" data-onboarding="language">{o("language", "대화 언어")}</label>
      <select id="setup-language" value={form.language} onChange={e => {
        const language = LangSchema.safeParse(e.currentTarget.value);
        if (language.success) setForm(f => ({ ...f, language: language.data }));
      }}>{LANG_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label htmlFor="setup-key" data-onboarding="key">{o("key", "OpenAI API 키")}</label>
      <input id="setup-key" type="password" maxLength={512} autoComplete="off" spellCheck={false} aria-describedby="setup-key-hint"
        value={form.apiKey} onChange={e => { const apiKey = e.currentTarget.value; setForm(f => ({ ...f, apiKey })); }}/>
      <p className="hint" id="setup-key-hint">{keyHint(lang, dialog?.keyState)}</p>
      <label htmlFor="setup-region" data-onboarding="region">{o("region", "지역 안내에 사용할 시·도 (선택)")}</label>
      <select id="setup-region" value={form.region} onChange={e => { const region = e.currentTarget.value; setForm(f => ({ ...f, region })); }}>
        <option value="" data-onboarding="none">{o("none", "선택 안 함")}</option>
        {form.regions.map(region => <option key={region} value={region}>{region}</option>)}
      </select>
      <label htmlFor="setup-speed" data-onboarding="speed">{o("speed", "안내 속도")}</label>
      <select id="setup-speed" value={form.speed} onChange={e => { const speed = e.currentTarget.value; setForm(f => ({ ...f, speed })); }}>
        {SPEEDS.map(([value, key, label]) => <option key={value} value={value} data-onboarding={key}>{o(key, label)}</option>)}
        {form.extraSpeed !== undefined && <option value={form.extraSpeed}>{form.extraSpeed}배</option>}
      </select>
      <label htmlFor="setup-device" data-onboarding="device">{o("device", "이 PC를 누가 사용하나요?")}</label>
      <select id="setup-device" value={form.deviceUse} disabled={form.deviceLocked} onChange={e => {
        const deviceUse = DEVICES.find(([value]) => value === e.currentTarget.value)?.[0] ?? "unidentified";
        setForm(f => ({ ...f, deviceUse, rememberService: deviceUse === "personal" && f.rememberService }));
      }}>{DEVICES.map(([value, key, label]) => <option key={value} value={value} data-onboarding={key}>{o(key, label)}</option>)}</select>
      <label><input id="setup-remember-service" type="checkbox" disabled={!personal} checked={form.rememberService}
        onChange={e => { const rememberService = e.currentTarget.checked; setForm(f => ({ ...f, rememberService })); }}/> <span data-onboarding="remember">{o("remember", "개인 PC에서 다음 이용에도 마지막 기관과 업무 이름 기억하기")}</span></label>
      <label htmlFor="setup-browser" data-onboarding="browser">{o("browser", "사이트를 열 브라우저 (개인 PC, 다음 실행부터)")}</label>
      <select id="setup-browser" value={form.browser} disabled={!personal} onChange={e => {
        const browser = e.currentTarget.value === "chrome" ? "chrome" : "separate";
        setForm(f => ({ ...f, browser }));
      }}>{BROWSERS.map(([value, key, label]) => <option key={value} value={value} data-onboarding={key}>{o(key, label)}</option>)}</select>
      <p className="hint" id="setup-browser-fallback" hidden={!form.browserFallback} data-onboarding="fallback">{o("fallback", "평소 쓰는 크롬을 열 수 없어서 따로 쓰는 브라우저를 쓰고 있어요.")}</p>
      <label id="setup-autostart-row" hidden={autostart === undefined}><input id="setup-autostart" type="checkbox" checked={form.autostart}
        onChange={e => { const on = e.currentTarget.checked; setForm(f => ({ ...f, autostart: on })); }}/> <span data-onboarding="autostart">{o("autostart", "컴퓨터를 켤 때 청음도 켜기")}</span></label>
      <p className="error" id="setup-error" role="alert" hidden={dialog?.error === undefined}>{dialog?.error}</p>
      <div className="row">
        <button className="primary" id="setup-save" type="submit" disabled={busy}>{saveLabel(lang, continuing)}</button>
        <button id="setup-cancel" data-onboarding="cancel" type="button" disabled={dialog?.saving === true} onClick={() => ref.current?.close()}>{o("cancel", "취소")}</button>
      </div>
    </form>
  </dialog>;
}
