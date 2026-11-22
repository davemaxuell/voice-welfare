// 이용 설정과 시작 안내의 문구표. src/cheongeum/web/static/onboarding.js에서 그대로 옮겼다.
export const languages: Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>> = {
  ko: {
    saved: '설정된 키가 있어요. 교체할 때만 새 키를 입력하세요.', empty: '키를 비워 두면 글로 시작할 수 있어요.',
    error: '저장된 설정을 읽을 수 없어요. 키를 다시 입력해 주세요.', save: '저장하고 시작', resume: '저장하고 대화 계속하기',
  },
  en: {
    title: 'Cheongeum settings', about: 'Your OpenAI API key enables dictation, spoken replies and public-service searches. The key is encrypted on this PC.',
    key: 'OpenAI API key', language: 'Conversation language', region: 'Province or city for local services (optional)', speed: 'Speech speed',
    device: 'Who uses this PC?', none: 'No selection', personal: 'Only me', shared: 'Several people', remember: 'Remember the last agency and service on my personal PC',
    browser: 'Browser for websites (personal PC, from next start)', separate: 'Separate browser', chrome: 'Usual Chrome (keeps logins)',
    fallback: 'Your usual Chrome could not open, so a separate browser is in use.', autostart: 'Start Cheongeum when the computer starts',
    slow: 'Slow · 0.85×', normal: 'Normal · 1×', fast: 'Fast · 1.35×', faster: 'Faster · 1.6×', cancel: 'Cancel',
    saved: 'A key is saved. Enter a new one to replace it.', empty: 'Leave this blank to start by typing.', error: 'Enter your key again to restore the saved settings.',
    save: 'Save and start', resume: 'Save and continue',
    welcome: 'Welcome to Cheongeum', lead: 'Find civil services, scholarships and welfare benefits, and read public-service pages together.',
    hear: 'Hear the introduction', yes: 'Agree and start', no: 'Decline', details: 'Voice and privacy guide', replay: 'Read the full guide',
    guide: 'Cheongeum opens the website you request, reads it aloud, and clicks or fills in the items you ask for. Enter passwords and complete identity checks directly on the website.',
    image: 'Cheongeum first checks the page text. When your question needs a visual detail, it sends OpenAI a full-page screenshot of the current tab, page text and recent requests. It masks form fields, embedded documents and detected personal details. Images can still contain personal information. Say “describe the screen without a screenshot” for text only.',
    files: 'When you ask for file analysis, the selected file or its text is sent to OpenAI.',
    keyed: 'Audio and spoken replies use your speech API. Recordings are not saved.', typed: 'You can type. Add an API key in settings to use voice.',
    liveHistory: 'Starting a live voice call sends a short excerpt of this conversation to OpenAI with detected personal details masked.',
    model: 'Questions and page text may be sent to these configured services', local: 'Text commands run locally.',
    stop: 'Keep passwords and resident registration numbers private. Say “stop” at any time.', keyboard: 'Press Enter to agree or Escape to decline.',
    background: 'To agree, press {key}, Shift and Space. To decline, quit Cheongeum from its menu.',
  },
  zh: {
    title: '青音设置', about: '使用您的 OpenAI API 密钥进行语音输入、朗读和公共服务查询。密钥在本机加密保存。',
    key: 'OpenAI API 密钥', language: '对话语言', region: '查询本地服务的省或市（可选）', speed: '朗读速度',
    device: '谁使用这台电脑？', none: '未选择', personal: '仅我自己', shared: '多人共用', remember: '在我的个人电脑上记住上次的机构和服务',
    browser: '打开网站的浏览器（个人电脑，下次启动起）', separate: '单独的浏览器', chrome: '平时的 Chrome（保留登录）',
    fallback: '无法打开平时的 Chrome，正在使用单独的浏览器。', autostart: '电脑开机时启动青音',
    slow: '慢 · 0.85倍', normal: '正常 · 1倍', fast: '快 · 1.35倍', faster: '更快 · 1.6倍', cancel: '取消',
    saved: '已有密钥。更换时才需重新输入。', empty: '留空即可开始打字提问。', error: '无法读取原设置，请重新输入密钥。',
    save: '保存并开始', resume: '保存并继续',
    welcome: '欢迎使用青音', lead: '查找政务、奖学金和福利信息，一起阅读公共服务网页。',
    hear: '收听使用说明', yes: '同意并开始', no: '不同意', details: '语音使用与隐私说明', replay: '朗读完整说明',
    guide: '青音会打开您指定的网站，为您朗读网页，并按您的要求点击或填写表单。请在网站上亲自输入密码、完成身份验证。',
    image: '青音会先查看网页文字。需要查看图像才能回答时，才会将当前标签页的整页截图、网页文字和最近的部分请求发送给 OpenAI。输入框、嵌入文档和检测到的个人信息会被遮挡。图片中仍可能包含个人信息。您可以说“只读文字，不要截图”。',
    files: '当您请求分析文件时，所选文件或正文会发送给 OpenAI。',
    keyed: '语音输入和朗读使用您配置的语音接口。青音不保存录音。', typed: '您可以打字提问。在设置中添加密钥即可使用语音。',
    liveHistory: '开始实时语音对话时，近期的部分对话内容会发送至 OpenAI，检测到的个人信息会被遮盖。',
    model: '问题和网页文字可能发送到以下已配置的服务', local: '文字指令在本机处理。',
    stop: '请保管好密码和居民登记号码。随时说“停止”即可停下。', keyboard: '按回车同意，按 Esc 不同意。',
    background: '同时按 {key}、Shift 和空格键同意。若不同意，请通过青音菜单退出。',
  },
  ja: {
    title: 'チョンウムの設定', about: 'ご自身の OpenAI API キーで音声入力、読み上げ、公共サービスの検索ができます。キーはこのパソコンに暗号化して保存します。',
    key: 'OpenAI API キー', language: '会話の言語', region: '地域の案内に使う市・道（任意）', speed: '読み上げ速度',
    device: 'このパソコンを使う方', none: '選択しない', personal: '自分だけ', shared: '複数の人', remember: '個人用パソコンに前回の機関とサービスを記憶する',
    browser: 'サイトを開くブラウザー（個人用パソコン、次回起動から）', separate: '別のブラウザー', chrome: 'いつもの Chrome（ログインを保持）',
    fallback: 'いつもの Chrome を開けなかったため、別のブラウザーを使っています。', autostart: 'パソコンの起動時にチョンウムも起動する',
    slow: 'ゆっくり · 0.85倍', normal: '標準 · 1倍', fast: '速い · 1.35倍', faster: 'より速い · 1.6倍', cancel: 'キャンセル',
    saved: 'キーは登録済みです。変更するときだけ入力してください。', empty: '空欄のまま文字入力で始められます。', error: '設定を読み込めません。キーを再入力してください。',
    save: '保存して開始', resume: '保存して会話を続ける',
    welcome: 'チョンウムへようこそ', lead: '行政手続き、奨学金、福祉制度を探し、公共サービスのページを一緒に読みます。',
    hear: '使い方を聞く', yes: '同意して開始', no: '同意しない', details: '音声利用とプライバシーの説明', replay: '説明をすべて聞く',
    guide: 'チョンウムは指定されたサイトを開いて読み上げ、ご依頼に応じて項目を押したり入力したりします。パスワードの入力と本人確認は、サイト上でご自身で行ってください。',
    image: 'まずページの文字を確認します。画像を見て答える必要があるときは、今のタブのページ全体の画像と本文、直近の依頼の一部を OpenAI に送ります。入力欄、埋め込み文書、検出した個人情報は隠します。画像には個人情報が残ることがあります。「スクリーンショットなしで説明して」とも言えます。',
    files: 'ファイルの分析を依頼すると、選んだファイルまたは本文が OpenAI に送られます。',
    keyed: '音声入力と読み上げには設定した音声 API を使います。録音は保存しません。', typed: '文字で質問できます。設定でキーを登録すると音声を使えます。',
    liveHistory: 'リアルタイム音声会話を始めると、最近の会話の一部が OpenAI に送信されます。検出した個人情報は隠します。',
    model: '質問やページの文章が次のサービスに送られることがあります', local: '文字の指示はこのパソコンで処理します。',
    stop: 'パスワードや住民登録番号は口にしないでください。「ストップ」と言えばいつでも止まります。', keyboard: '同意は Enter キー、同意しない場合は Esc キーを押してください。',
    background: '同意するには {key}、Shift、スペースを同時に押してください。同意しない場合はチョンウムのメニューから終了してください。',
  },
};

export function koreanConsentGuide(visionDisabled: boolean, voice: string, model: string, background: boolean, mac: boolean, awaitingConsent: boolean) {
  return (
    "공공서비스 음성 도우미 청음입니다. " +
    "요청하신 웹사이트를 열고 화면을 읽어 드립니다. 말씀하신 항목을 누르거나 칸에 입력해 드려요. 비밀번호 입력과 본인 인증은 사이트에서 직접 해 주세요. " +
    (visionDisabled
      ? "이 설정에서는 웹페이지를 글로 읽어 드립니다. "
      : "화면 설명은 먼저 페이지 글을 확인합니다. 그림을 봐야 답할 수 있으면 현재 탭의 전체 페이지 사진도 본문, 최근 요청 일부와 함께 OpenAI에 보냅니다. 입력란과 내장 문서, 감지된 개인정보는 가립니다. 그림 속 개인정보는 남을 수 있습니다. 글로만 들으려면 “사진 없이 화면 설명해 줘”라고 하세요. ") +
    "받은 파일에 대해 질문하거나 요약을 요청하면 해당 파일이나 본문을 OpenAI에 보냅니다. " +
    `${voice} ${model} 비밀번호나 주민등록번호는 말하지 마세요. ` +
    "언제든 '멈춰'라고 말하면 멈춥니다." +
    (!awaitingConsent ? "" : background
      ? ` 동의하시면 ${mac ? "커맨드" : "컨트롤"}, 시프트, 스페이스 키를 함께 눌러 주세요. 동의하지 않으시면 메뉴 막대의 청음에서 종료를 고르세요.`
      : " 동의하시면 Enter를, 동의하지 않으시면 Escape를 눌러 주세요.")
  );
}
