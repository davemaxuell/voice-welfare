import { LANG_INDEX, RESULT_WORDS, type Entry } from "../../src/core/research_copy.ts";
import type { Lang } from "../../src/core/turn.ts";

export const workflowCopy = {
  title: ["자료 조사와 저장한 메모", "Research and saved notes", "资料调查和已存笔记", "資料調査と保存したメモ"],
  statusLabel: ["자료 조사", "Research", "资料调查", "資料調査"],
  researchLabel: ["공개 자료에서 확인할 질문", "Question for public sources", "要查阅公开资料的问题", "公開資料で調べる質問"],
  researchStorage: ["질문과 결과가 저장되며 앱을 다시 열면 조사가 이어집니다.", "Your question and results are saved so research can continue when you reopen the app.", "问题和结果会保存，重新打开应用后将继续调查。", "質問と結果は保存され、アプリを再度開くと調査を続けられます。"],
  researchConsent: [
    "이 질문과 결과를 저장하고 앱을 다시 열어도 조사를 이어가는 데 동의해요.",
    "Save this question and its results, and continue the research when I reopen the app.",
    "同意保存问题和结果，重新打开应用时继续调查。",
    "質問と結果を保存し、アプリを再度開いたときも調査を続けることに同意します。",
  ],
  researchAdd: ["조사 맡기기", "Start research", "开始调查", "調査を依頼"],
  noteLabel: ["기억할 선호 사항이나 찾을 내용", "Preference to remember or terms to find", "要记住的偏好或要搜索的词", "覚えておく希望や検索語"],
  noteStorage: ["저장한 메모는 대화 중 관련 질문과 함께 OpenAI에서 검색합니다.", "Saved notes are matched with relevant questions through OpenAI.", "保存的笔记会通过 OpenAI 与相关问题匹配。", "保存したメモは OpenAI を通じて関連する質問と照合します。"],
  noteConsent: [
    "이 메모를 저장하고 관련 질문과 함께 OpenAI에서 검색해 대화에 활용하는 데 동의해요.",
    "Save this note and use OpenAI to match it with relevant questions during conversations.",
    "同意保存此笔记，并在对话中通过 OpenAI 与相关问题进行匹配。",
    "このメモの保存と、会話中に OpenAI で関連する質問と照合することに同意します。",
  ],
  noteAdd: ["메모 저장", "Save note", "保存笔记", "メモを保存"],
  noteSearch: ["메모 찾기", "Find notes", "查找笔记", "メモを検索"],
  noteAll: ["전체 보기", "Show all", "显示全部", "すべて表示"],
  cancel: ["중단", "Cancel", "取消", "中止"],
  delete: ["삭제", "Delete", "删除", "削除"],
  revise: ["질문 수정", "Revise question", "修改问题", "質問を修正"],
  retry: ["다시 시도", "Try again", "重试", "再試行"],
  noMatchingNotes: ["관련 메모가 없어요.", "No matching notes.", "没有匹配的笔记。", "該当するメモはありません。"],
  updatedAt: ["최근 확인 {time}", "Updated {time}", "最近更新 {time}", "最終確認 {time}"],
  submittedJob: ["“{title}” 조사를 접수했어요.", "Queued research: “{title}”.", "已受理调查：“{title}”。", "「{title}」の調査を受け付けました。"],
  answeredJob: ["“{title}” 조사를 이어가요.", "Continuing research: “{title}”.", "正在继续调查：“{title}”。", "「{title}」の調査を再開しました。"],
  cancelledJob: ["“{title}” 조사를 중단했어요.", "Cancelled research: “{title}”.", "已取消调查：“{title}”。", "「{title}」の調査を中止しました。"],
  cancelAlreadyFinished: [
    "“{title}” 조사는 이미 상태가 바뀌어 중단하지 않았어요.",
    "Research “{title}” already changed state and was not cancelled.",
    "调查“{title}”的状态已更新，未执行取消。",
    "「{title}」の調査はすでに状態が変わっていたため中止しませんでした。",
  ],
  deletedJob: ["“{title}” 조사를 삭제했어요.", "Deleted research: “{title}”.", "已删除调查：“{title}”。", "「{title}」の調査を削除しました。"],
  deleteAlreadyRemoved: [
    "“{title}” 조사는 이미 삭제되었거나 상태가 바뀌었어요.",
    "Research “{title}” was already deleted or changed state.",
    "调查“{title}”已被删除或状态已更新。",
    "「{title}」の調査はすでに削除されたか状態が変わっています。",
  ],
  retriedJob: ["“{title}” 조사를 다시 맡겼어요.", "Retried research: “{title}”.", "已重新开始调查：“{title}”。", "「{title}」の調査を再依頼しました。"],
  noteSaved: ["메모를 저장했어요.", "Saved your note.", "已保存笔记。", "メモを保存しました。"],
  noteDeleted: ["메모를 삭제했어요.", "Deleted the note.", "已删除笔记。", "メモを削除しました。"],
  collapsedDone: ["자료 조사 {count}건이 완료됐어요.", "{count} research update(s) finished.", "有 {count} 项资料调查已完成。", "資料調査が{count}件完了しました。"],
  collapsedNeedsInput: ["자료 조사 {count}건에 추가 확인이 필요해요.", "{count} research update(s) need your input.", "有 {count} 项资料调查需要补充说明。", "資料調査{count}件に補足回答が必要です。"],
  collapsedUnfinished: ["자료 조사 {count}건을 마치지 못했어요.", "{count} research update(s) did not complete.", "有 {count} 项资料调查未能完成。", "資料調査{count}件を完了できませんでした。"],
  unreadBadgeLabel: ["확인할 조사 알림 {count}건", "{count} unread research update(s)", "{count} 项未读调查更新", "未確認の調査通知{count}件"],
  actionForItem: ["{action}: {title}", "{action}: {title}", "{action}：{title}", "{action}：{title}"],
} as const satisfies Record<string, Entry>;

export const states = {
  queued: ["접수됨", "Queued", "排队中", "受付済み"],
  running: ["조사 중", "Researching", "调查中", "調査中"],
  completed: ["조사 완료", "Completed", "已完成", "調査完了"],
  partial: ["일부 확인", "Partially verified", "部分已确认", "一部確認"],
  incomplete: ["확인하지 못함", "Unverified", "未能确认", "未確認"],
  failed: ["실패", "Failed", "失败", "失敗"],
  needs_input: ["질문 보완 필요", "Clarification needed", "需要补充说明", "質問の補足が必要"],
  cancelled: ["중단됨", "Cancelled", "已取消", "中止済み"],
} as const satisfies Record<string, Entry>;

export const resultCopy = {
  ...RESULT_WORDS,
  answer: ["공개 정보로 답하기", "Reply with public information", "用公开信息回复", "公開情報で回答"],
  resume: ["조사 이어가기", "Continue research", "继续调查", "調査を続ける"],
  read: ["결과 듣기", "Read result aloud", "朗读结果", "結果を読み上げる"],
} as const satisfies Record<string, Entry>;

export const errorCopy = {
  PUBLIC_TEXT_REQUIRED: [
    "저장하거나 검색할 내용을 확인해 주세요. 개인 연락처나 인증 정보는 빼고 다시 시도해 주세요.",
    "Check the text and remove personal contact details or credentials, then try again.",
    "请检查输入内容，删除个人联系方式或认证信息后再试。",
    "入力内容を確認し、個人の連絡先や認証情報を除いてから再度お試しください。",
  ],
  WORKSPACE_LIMIT: [
    "저장 한도에 도달했어요. 완료한 조사나 메모를 삭제한 뒤 다시 시도해 주세요.",
    "You reached the workspace limit. Delete a finished lookup or note and try again.",
    "已达到保存上限。请删除已结束的调查或笔记后再试。",
    "保存上限に達しました。終了した調査やメモを削除してから再度お試しください。",
  ],
  REQUEST_CONFLICT: [
    "이미 처리되었거나 상태가 바뀌었어요. 목록을 다시 확인한 뒤 시도해 주세요.",
    "This item has already changed. Refresh the list and try again.",
    "此项状态已更新。请刷新列表后再试。",
    "すでに状態が変わっています。一覧を確認してから再度お試しください。",
  ],
  WORKSPACE_PERSONAL_REQUIRED: [
    "개인 PC 설정과 시작 동의가 필요해요. 이용 설정을 확인해 주세요.",
    "Personal device mode and consent are required. Check your settings and try again.",
    "需要个人电脑模式和开始同意。请检查设置后再试。",
    "個人用端末の設定と開始同意が必要です。利用設定をご確認ください。",
  ],
  REQUEST_ID_REQUIRED: [
    "요청 식별 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
    "The request identifier could not be verified. Please try again.",
    "无法确认请求标识，请稍后再试。",
    "リクエスト識別情報を確認できませんでした。もう一度お試しください。",
  ],
  BODY_TOO_LARGE: [
    "입력 내용이 너무 길어요. 글자 수를 줄여 다시 시도해 주세요.",
    "The request text is too long. Shorten it and try again.",
    "输入内容过长，请缩短后再试。",
    "入力が長すぎます。文字数を減らして再度お試しください。",
  ],
  NO_SESSION: [
    "세션이 종료됐어요. 새 작업을 시작한 뒤 다시 시도해 주세요.",
    "This session has ended. Start a new session and try again.",
    "会话已结束。请开始新任务后再试。",
    "セッションが終了しました。新しい作業を始めてから再度お試しください。",
  ],
  SESSION_WRITER_REQUIRED: [
    "다른 창에서 세션을 제어하고 있어요. 이 창을 새로 연결한 뒤 다시 시도해 주세요.",
    "Another window controls this session. Reconnect this tab and try again.",
    "另一个窗口正在控制此会话。请重新连接此标签页后再试。",
    "別のウィンドウがセッションを制御しています。再接続してからお試しください。",
  ],
  default: [
    "처리하지 못했어요. 연결을 확인한 뒤 잠시 후 다시 시도해 주세요.",
    "The request failed. Check your connection and try again shortly.",
    "请求失败。请检查连接后稍后再试。",
    "処理できませんでした。接続を確認してから少し待って再度お試しください。",
  ],
} as const satisfies Record<string, Entry>;

function format(template: string, values?: Readonly<Record<string, string | number>>): string {
  return values === undefined ? template : template.replace(/\{(\w+)\}/gu, (slot, name: string) => String(values[name] ?? slot));
}

export function workflowText(key: keyof typeof workflowCopy, lang: Lang, values?: Readonly<Record<string, string | number>>): string {
  return format(workflowCopy[key][LANG_INDEX[lang]], values);
}

export function workflowStateText(state: string, lang: Lang): string {
  return Object.hasOwn(states, state) ? states[state as keyof typeof states][LANG_INDEX[lang]] : state;
}

export function workflowResultText(key: keyof typeof resultCopy, lang: Lang): string {
  return resultCopy[key][LANG_INDEX[lang]];
}

export function workflowErrorText(code: string | undefined, lang: Lang): string {
  const key = code !== undefined && Object.hasOwn(errorCopy, code) ? code as keyof typeof errorCopy : "default";
  return errorCopy[key][LANG_INDEX[lang]];
}
