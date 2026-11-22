import type { DialogInfo, NativeDialogRecord, NoticeFacts } from "../../core/actions.ts";
import { strip } from "../../core/text.ts";
import { redactText } from "../../safety/privacy.ts";
import { josa } from "../../speech/phrasing.ts";

// 안내 팝업을 묻지 않고 닫았을 때, 사이트가 띄운 질문(팝업·confirm() 창)을 사용자에게 말해 줄 문장. 모두 코드가 만든다(모델이 쓴 말이 아니다).
// 팝업·창의 글은 화면 글이라 신뢰할 수 없는 데이터지만 소리로 읽어 줄 때는 다른 화면 글처럼 비식별화해서 읽는다.

/** 묻지 않고 닫은 안내 팝업이 말한 내용(제목과 단추를 뺀 글). */
export interface NoticeSaid { title: string; text: string }

const spaces = /\p{White_Space}+/gu;

/** 닫은 안내의 제목·글. 단추 이름은 글에서 뺀다(맨 뒤에 있는 것부터 한 번만). */
export function noticeSaid(facts: NoticeFacts, buttonName: string): NoticeSaid {
  const title = strip(facts.title.replace(spaces, " "));
  let body = facts.text;
  const at = buttonName.length > 0 ? body.lastIndexOf(buttonName) : -1;
  if (at >= 0) body = body.slice(0, at) + " " + body.slice(at + buttonName.length);
  body = strip(body.replace(spaces, " "));
  if (title.length > 0 && body.startsWith(title)) body = strip(body.slice(title.length));
  return { title: redactText(title), text: redactText(body) };
}

const ended = /[.!?。…]$/u;

/** "안내 팝업 '제목'이 떠서 닫았어요. 내용은 ….": 장애인연금 연습 신청서에서 쓰던 말을 그대로 따른다. */
export function noticeSpeech(notices: readonly NoticeSaid[]): string {
  return notices.map(notice => {
    const head = notice.title.length > 0 ? `안내 팝업 ${josa(`'${notice.title}'`, "이", "가")} 떠서 닫았어요.` : "안내 팝업이 떠서 닫았어요.";
    return notice.text.length > 0 ? `${head} 내용은 ${notice.text}${ended.test(notice.text) ? "" : "."}` : head;
  }).join(" ");
}

/** 닫기 전에 같은 안내를 이미 말했는지 가리는 열쇠(주소의 출처와 제목·글). */
export function noticeKey(origin: string, said: NoticeSaid): string {
  return origin + "\n" + said.title + "\n" + said.text;
}

// ---- 사이트가 띄운 질문 팝업(안내로 볼 수 없는 팝업) ----

/** 누르고 나서 떠서 그대로 남은 팝업. 읽어 주고 사용자가 고르게 한다(청음이 고르지 않는다). */
export interface PopupQuestion { title: string; text: string; choices: string[]; cut: boolean; dialogIndex: number }

const QUESTION_CHOICES = 6;
const QUESTION_TEXT_LIMIT = 300;

/**
 * 관찰된 팝업을 사용자에게 읽어 줄 질문으로 만든다. 고를 수 있는 것은 팝업 안에서 관찰된 조작 요소의 이름(names, 없으면 팝업의 단추 이름)이다.
 * 이름이 없는 조작 요소만 있거나 고를 것이 없는 팝업은 질문이 아니다(undefined). 글에서는 고를 것의 이름을 뒤에서부터 한 번씩 빼고 제목을 앞에서 뺀다.
 */
export function popupQuestion(dialog: DialogInfo, names: readonly string[], dialogIndex: number): PopupQuestion | undefined {
  const observed = names.map(name => strip(name.replace(spaces, " "))).filter(name => name.length > 0);
  const buttons = dialog.buttons.map(name => strip(name.replace(spaces, " "))).filter(name => name.length > 0);
  const choices = [...new Set(observed.length > 0 ? observed : buttons)].slice(0, QUESTION_CHOICES);
  if (choices.length === 0) return undefined;
  const title = strip(dialog.title.replace(spaces, " "));
  let body = strip(dialog.text.replace(spaces, " "));
  for (const name of [...choices].reverse()) {
    if (body.endsWith(name)) body = strip(body.slice(0, body.length - name.length));
  }
  if (title.length > 0 && body.startsWith(title)) body = strip(body.slice(title.length));
  return {
    title: redactText(title), text: redactText(body), choices: choices.map(name => redactText(name)), dialogIndex,
    cut: Array.from(dialog.text).length >= QUESTION_TEXT_LIMIT,
  };
}

/** 팝업의 질문과 고를 수 있는 것을 읽어 주고 사용자의 선택을 기다린다. 어느 것을 누를지는 사용자가 정하고, 고른 단추는 보통 때처럼 정책 검사와 확인을 거친다. */
export function questionSpeech(question: PopupQuestion): string {
  const head = question.title.length > 0 ? `'${question.title}' 팝업에서` : "사이트 팝업에서";
  const body = question.text.length > 0
    ? ` 내용은 ${question.text}${ended.test(question.text) ? "" : "."}${question.cut ? " 글이 길어 앞부분만 읽었어요." : ""}` : "";
  const names = question.choices.map(name => `'${name}'`);
  const last = names.at(-1) ?? "";
  const list = names.length === 1 ? josa(last, "이에요", "예요") : `${names.slice(0, -1).join(", ")}, ${josa(last, "이에요", "예요")}`;
  const first = question.choices[0] ?? "";
  return `${head} 고를 수 있는 것은 ${list}.${body} 어느 것을 누를지 말씀해 주세요. 예를 들면 '${first} 눌러줘'라고 하시면 돼요.`;
}

/** 새로 보이는 글(revealed)에서 이미 따로 읽어 준 팝업의 글(said)에 든 줄은 뺀다. 같은 내용을 두 번 읽지 않으려는 것이다. */
export function revealedExcept(revealed: string | undefined, said: readonly string[]): string {
  const known = said.map(text => strip(text.replace(spaces, " "))).filter(text => text.length > 0);
  return (revealed ?? "").split("\n").map(line => strip(line.replace(spaces, " ")))
    .filter(line => line.length > 0 && !known.some(text => text.includes(line))).join("\n");
}

// ---- 사이트의 confirm() 창 ----

/**
 * 청음이 취소한 질문을 어떻게 알릴지.
 * answerable: 대신 답해도 되는 질문인지(한 번만 물었고, 신청·삭제 같은 말이 없고, 소리로 다 읽어 줄 수 있어야 한다). 아니면 직접 하시도록 알린다.
 * scope: 이 요청의 범위가 대신 답할 수 없는 경우. lookup = 정보를 찾는 요청, private = 내 화면을 확인하는 요청(질문 글을 읽지 않는다),
 * auto = 안내 팝업을 묻지 않고 닫다가 사이트가 물었다. 없으면 사용자가 직접 시킨 누르기다.
 */
export interface NativeQuestion {
  record: NativeDialogRecord; answerable: boolean; count: number; scope?: "lookup" | "private" | "auto";
}

/** 사이트가 물어서(confirm) 청음이 취소한 질문을 사용자에게 알리는 말. 대신 답해도 되는 질문이면 진행할지를 함께 묻는다. */
export function nativeSpeech({ record, answerable, count, scope }: NativeQuestion): string {
  const said = redactText(record.preview);
  if (answerable) {
    return `사이트가 '${said}'라고 물어서 아직 진행하지 않았어요. 진행할까요? 진행하려면 '진행해', 그만두려면 '거절'이라고 말씀해 주세요.`;
  }
  const own = "화면에서 내용을 직접 확인하고 진행해 주세요.";
  if (scope === "private") {
    return `사이트가 확인 창으로 질문을 해서 제가 취소했어요. 개인 화면이라 질문 내용은 읽지 않았고 제가 대신 답하지도 않았어요. ${own}`;
  }
  if (count > 1) return `사이트가 질문을 여러 번 해서 제가 대신 답하지 않았어요. ${own}`;
  if (record.risk === "long") return `사이트가 긴 안내문으로 물어서 제가 대신 답하지 않았어요. 앞부분은 '${said}'예요. ${own}`;
  if (scope === "lookup") return `사이트가 '${said}'라고 물었어요. 정보를 찾는 동안에는 제가 대신 답하지 않고 취소했어요. ${own}`;
  if (scope === "auto") return `안내 팝업을 닫다가 사이트가 '${said}'라고 물어서 제가 취소했어요. 대신 답하지는 않았어요. ${own}`;
  return `사이트가 '${said}'라고 물었어요. 신청이나 삭제, 로그인처럼 중요한 일일 수 있어서 제가 대신 답하지 않았어요. ${own}`;
}
