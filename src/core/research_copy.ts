import type { Lang } from "./turn.ts";

export const LANG_INDEX: Readonly<Record<Lang, 0 | 1 | 2 | 3>> = { ko: 0, en: 1, zh: 2, ja: 3 };
export type Entry = readonly [string, string, string, string];

export const STATE_NOTES = {
  queued: [
    "차례를 기다리고 있어요. 순서가 되면 자동으로 조사를 시작해요.",
    "Waiting in queue. Research will start automatically.",
    "正在排队，轮到时会自动开始调查。",
    "順番を待っています。順番になると自動で調査を始めます。",
  ],
  running: [
    "공개 자료를 확인하고 있어요. 패널을 닫아 두어도 계속 진행돼요.",
    "Checking public sources. Research continues if you close this panel.",
    "正在查阅公开资料。关闭面板后仍会继续。",
    "公開資料を確認しています。パネルを閉じても調査は続きます。",
  ],
  completed: [
    "공개 자료 확인을 마쳤어요. 아래 출처와 확인일을 함께 확인해 주세요.",
    "Finished checking public sources. Review the sources and checked date below.",
    "已完成公开资料核实。请查看下方的来源和核实日期。",
    "公開資料の確認が完了しました。下の出典と確認日をご確認ください。",
  ],
  partial: [
    "일부 항목은 확인했고, 남은 항목은 아래에 정리했어요.",
    "Some items were verified. Remaining items are listed below.",
    "部分项目已核实，尚未确认的项目列在下方。",
    "一部の項目を確認しました。残りの項目は下をご確認ください。",
  ],
  incomplete: [
    "공개 자료에서 확인하지 못했어요. 질문을 구체적으로 수정해 다시 시도해 주세요.",
    "Could not verify this from public sources. Revise the question and try again.",
    "未能从公开资料中核实。请修改问题使其更具体后再试。",
    "公開資料からは確認できませんでした。質問を具体的に修正して再度お試しください。",
  ],
  failed: [
    "조사를 마치지 못했어요. 연결을 확인한 뒤 다시 시도하거나 질문을 수정해 주세요.",
    "The lookup could not be completed. Check your connection, then try again or revise the question.",
    "未能完成调查。请检查连接后重试，或修改问题。",
    "調査を完了できませんでした。接続を確認して再試行するか、質問を修正してください。",
  ],
  needs_input: [
    "조사를 이어가려면 아래 질문에 공개 정보로 답해 주세요.",
    "Reply with public information below to continue the research.",
    "请在下方用公开信息回复，以便继续调查。",
    "調査を続けるには、下の質問に公開情報でお答えください。",
  ],
  cancelled: [
    "조사를 중단했어요. 이미 확인된 내용이나 외부 상태는 되돌리지 않았어요.",
    "Research stopped. Nothing already checked was rolled back.",
    "调查已停止。已检查的内容未回滚。",
    "調査を中止しました。すでに確認された内容の取り消しは行っていません。",
  ],
} as const satisfies Record<string, Entry>;

export const RESULT_WORDS = {
  source: ["출처", "Source", "来源", "出典"],
  missing: ["확인이 남은 항목", "Still to verify", "待核实项目", "確認が残っている項目"],
  checked: ["출처 확인일", "Source checked", "核实日期", "出典の確認日"],
  unknownDate: ["날짜 기록 없음", "Date unavailable", "日期未知", "日付不明"],
  dataDate: ["자료 기준일", "Data date", "数据基准日期", "データ基準日"],
  live: ["기관 자료", "Agency data", "机构数据", "機関のデータ"],
  stored: ["저장 자료", "Stored data", "存档数据", "保存データ"],
  "private-program": ["민간 사업 자료", "Private program data", "民间项目数据", "民間制度のデータ"],
} as const satisfies Record<string, Entry>;

export const RESEARCH_UNDELIVERED: Record<Lang, string> = {
  ko: "조사 결과를 전달하지 못했어요. 다시 요청해 주세요.",
  en: "I couldn’t deliver the research result. Please ask again.",
  zh: "调查结果未能送达，请再问一次。", ja: "調査結果をお伝えできませんでした。もう一度ご依頼ください。",
};

export const RESEARCH_RESTART: Record<Lang, string> = {
  ko: "이 조사는 이어서 답을 받을 수 없어요. 새로 맡겨 주세요.",
  en: "This research can’t take an answer. Please ask for it again as new research.",
  zh: "这项调查无法继续接收回答。请重新委托调查。", ja: "この調査は続けてお答えを受け取れません。新しく調査をご依頼ください。",
};

export function stateNote(state: string, lang: Lang): string {
  return Object.hasOwn(STATE_NOTES, state) ? STATE_NOTES[state as keyof typeof STATE_NOTES][LANG_INDEX[lang]] : "";
}

export function resultWord(key: keyof typeof RESULT_WORDS, lang: Lang): string {
  return RESULT_WORDS[key][LANG_INDEX[lang]];
}
