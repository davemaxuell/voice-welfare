import type { Lang } from "../core/turn.ts";

export function inspectionClickQuestion(lang: Lang, site: string, title: string, name: string): string {
  const questions = {
    ko: `${site}의 ‘${title}’ 화면에서 ‘${name}’ 항목을 찾았어요. 누르면 어떤 일이 일어날지 확인하기 어려워요. 누르려면 ‘눌러’, 그만두려면 ‘거절’이라고 말씀해 주세요.`,
    en: `I found “${name}” on the “${title}” page at ${site}. I can't verify what pressing it will do. Say “approve” to press it once or “no” to stop.`,
    zh: `我在 ${site} 的“${title}”页面找到了“${name}”。我无法核实点击后会发生什么。要点击一次，请说“确认”，要停止请说“取消”。`,
    ja: `${site}の「${title}」画面に「${name}」があります。押すと何が起きるか確認できません。一度押すには「承認します」、中止するには「いいえ」と言ってください。`,
  };
  return questions[lang];
}

export const PERSONAL_BROWSE_TEXT = {
  discover: {ko: "기관의 공식 사이트를 찾고 있어요.", en: "I'm looking for the official website.", zh: "正在查找机构的官方网站。", ja: "機関の公式サイトを探しています。"},
  entered: {ko: "사이트를 열었어요.", en: "I've opened the website.", zh: "已打开网站。", ja: "サイトを開きました。"},
  navigate: {ko: "요청하신 화면을 찾고 있어요.", en: "I'm looking for the page you requested.", zh: "正在查找您要的页面。", ja: "ご希望の画面を探しています。"},
  recover: {ko: "앞 화면에서 찾지 못해 다른 경로를 확인하고 있어요.", en: "That page didn't have it. I'm trying another route.", zh: "刚才的页面没有找到，正在尝试其他路径。", ja: "先ほどの画面になかったので、別の経路を探しています。"},
  inspect: {ko: "돌아온 화면에서 요청하신 내용을 확인하고 있어요.", en: "I'm checking the page you returned to.", zh: "正在查看您返回的页面。", ja: "お戻りになった画面を確認しています。"},
  verify: {ko: "화면의 내용과 답을 대조하고 있어요.", en: "I'm checking the answer against the page.", zh: "正在对照页面核实答案。", ja: "画面の内容と回答を照合しています。"},
  authStart: {
    ko: "사이트에서 로그인이나 본인확인을 직접 마친 뒤 '다 했어'라고 말씀해 주세요.",
    en: "Please sign in or verify your identity on the website. When you're done, say 'I'm done'.",
    zh: "请您在网站上亲自登录或验证身份。完成后请说“好了”。",
    ja: "サイトでご自身でログインまたは本人確認を行ってください。終わったら「終わりました」と言ってください。",
  },
  authCaptcha: {
    ko: "사이트의 보안문자나 사람 확인을 직접 처리해 주세요. 사이트가 음성 확인이나 다른 방법을 제공하면 그 방법을 쓸 수 있어요. 끝나면 '다 했어'라고 알려 주세요.",
    en: "Please complete the website's human verification yourself. You can use audio or another method if the site offers one. When you're done, say 'I'm done'.",
    zh: "请您亲自在网站上完成人机验证。如果网站提供语音验证或其他方式，也可以使用。完成后请说“好了”。",
    ja: "サイト上でご自身でロボットではないことを確認してください。音声など別の方法がある場合は利用できます。終わったら「終わりました」と言ってください。",
  },
  authApp: {
    ko: "휴대폰의 {app} 앱에서 인증을 마쳐 주세요. 인증번호는 앱이나 사이트에 직접 입력해 주세요. 끝나면 '다 했어'라고 말씀해 주세요.",
    en: "Please finish verification in the {app} app on your phone. Enter any verification code directly in the app or on the website. When you're done, say 'I'm done'.",
    zh: "请在手机上的 {app} 应用中完成认证。请直接在应用或网站上输入验证码。完成后请说“好了”。",
    ja: "携帯電話の {app} アプリで認証を行ってください。認証コードはアプリかサイトに直接入力してください。終わったら「終わりました」と言ってください。",
  },
  authShared: {
    ko: "이 컴퓨터에 로그인이 남을 수 있어요. 지우려면 '로그아웃해줘' 또는 '로그인 기록 지워줘'라고 말씀해 주세요.",
    en: "Your sign-in may remain on this computer. Sign out of the website when you're finished.",
    zh: "这台电脑可能会保留登录状态。使用完毕后，请退出网站账号。",
    ja: "このコンピューターにログイン状態が残ることがあります。使い終わったらサイトからログアウトしてください。",
  },
  authWaiting: {
    ko: "아직 로그인·인증 화면이에요. 사이트에서 마치신 뒤 다시 알려 주세요.",
    en: "You're still on the sign-in or verification page. Finish that step on the website, then say 'I'm done'.",
    zh: "目前仍在登录或验证页面。请在网站上完成后再说“好了”。",
    ja: "まだログインまたは本人確認の画面です。サイトで手続きを終えてから「終わりました」と言ってください。",
  },
  authWrongPage: {
    ko: "인증 뒤 돌아갈 화면을 아직 확인하지 못했어요. 원래 작업 화면으로 돌아가서 다시 알려 주세요.",
    en: "Please return to the original website, then say 'I'm done' again.",
    zh: "请回到原来的网站，然后再说“好了”。",
    ja: "元のサイトに戻ってから、もう一度「終わりました」と言ってください。",
  },
  authExpired: {
    ko: "인증 안내 시간이 지났어요. 필요하면 새로 요청해 주세요.",
    en: "The time to finish verification has expired. Please make your request again.",
    zh: "认证等待时间已过。请重新提出请求。",
    ja: "本人確認の待ち時間が過ぎました。必要ならもう一度ご依頼ください。",
  },
  authInterrupted: {
    ko: "인증하던 화면을 다시 확인하지 못했어요. 새로 시작해 주세요.",
    en: "I couldn't reopen the verification page. Please start again.",
    zh: "我无法重新查看认证页面。请重新开始。",
    ja: "本人確認の画面を再確認できませんでした。もう一度始めてください。",
  },
  authBlocked: {
    ko: "사이트에서 이 화면에 접근할 수 없어요.",
    en: "The website is blocking access to this page.",
    zh: "网站已阻止访问此页面。",
    ja: "このページへのアクセスがサイトによってブロックされています。",
  },
  authResumed: {
    ko: "원래 사이트로 돌아왔어요. 화면을 이어서 확인할게요.",
    en: "You're back on the original website. I'll continue checking the page.",
    zh: "已回到原来的网站。我会继续查看页面。",
    ja: "元のサイトに戻りました。画面の確認を続けます。",
  },
  incomplete: {
    ko: "요청을 모두 확인하지 못했어요.",
    en: "I couldn't confirm everything you asked for.",
    zh: "我无法确认您所要求的全部内容。",
    ja: "ご依頼の内容をすべて確認できませんでした。",
  },
  missing: {
    ko: "아직 확인이 필요한 내용은 ‘{detail}’예요.",
    en: "I still need to check “{detail}”.",
    zh: "还需要确认的是“{detail}”。",
    ja: "まだ確認が必要なのは「{detail}」です。",
  },
  currentPage: {
    ko: "현재 화면",
    en: "Current page",
    zh: "当前页面",
    ja: "現在の画面",
  },
} satisfies Record<string, Record<Lang, string>>;
