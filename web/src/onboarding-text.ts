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
    guide: 'With your consent, Cheongeum opens websites in a separate browser, reads them aloud and helps with practice forms. It asks before an action that needs approval. You handle identity verification and final submissions.',
    image: 'Cheongeum first checks the page text. When your question needs a visual detail, it sends OpenAI a full-page screenshot of the current tab, page text and recent requests. It masks form fields, embedded documents and detected personal details. Images can still contain personal information. Say “describe the screen without a screenshot” for text only.',
    files: 'For file analysis, you choose whether to send each file or its text to OpenAI after hearing the destination.',
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
    guide: '经您同意，青音会在单独的浏览器中打开网页，为您朗读并协助练习填表。需要批准的操作会事先询问。身份验证和正式提交由您本人完成。',
    image: '青音会先查看网页文字。需要查看图像才能回答时，才会将当前标签页的整页截图、网页文字和最近的部分请求发送给 OpenAI。输入框、嵌入文档和检测到的个人信息会被遮挡。图片中仍可能包含个人信息。您可以说“只读文字，不要截图”。',
    files: '分析文件前会说明接收方，由您逐个决定是否向 OpenAI 发送文件或正文。',
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
    guide: '同意すると、チョンウムが別のブラウザーでウェブサイトを開き、読み上げや練習用の申請書の記入をお手伝いします。承認の必要な操作は事前に確認します。本人確認と正式な提出はご自身で行います。',
    image: 'まずページの文字を確認します。画像を見て答える必要があるときは、今のタブのページ全体の画像と本文、直近の依頼の一部を OpenAI に送ります。入力欄、埋め込み文書、検出した個人情報は隠します。画像には個人情報が残ることがあります。「スクリーンショットなしで説明して」とも言えます。',
    files: 'ファイルの分析では、送信先を確認したうえで、ファイルまたは本文を OpenAI に送るか、その都度選べます。',
    keyed: '音声入力と読み上げには設定した音声 API を使います。録音は保存しません。', typed: '文字で質問できます。設定でキーを登録すると音声を使えます。',
    liveHistory: 'リアルタイム音声会話を始めると、最近の会話の一部が OpenAI に送信されます。検出した個人情報は隠します。',
    model: '質問やページの文章が次のサービスに送られることがあります', local: '文字の指示はこのパソコンで処理します。',
    stop: 'パスワードや住民登録番号は口にしないでください。「ストップ」と言えばいつでも止まります。', keyboard: '同意は Enter キー、同意しない場合は Esc キーを押してください。',
    background: '同意するには {key}、Shift、スペースを同時に押してください。同意しない場合はチョンウムのメニューから終了してください。',
  },
};

export function koreanConsentGuide(visionDisabled: boolean, voice: string, model: string, background: boolean, mac: boolean) {
  return (
    "공공서비스 음성 도우미 청음입니다. " +
    "동의하시면 청음은 별도의 브라우저 창에서 웹사이트를 열고 화면을 읽어 드립니다. 연습용 신청서 작성도 도와드려요. " +
    "승인이 필요한 입력이나 클릭은 실행 전에 대상과 내용을 알려 드립니다. 실제 접수와 본인 인증은 직접 하셔야 합니다. " +
    (visionDisabled
      ? "이 설정에서는 웹페이지를 글로 읽어 드립니다. "
      : "화면 설명은 먼저 페이지 글을 확인합니다. 그림을 봐야 답할 수 있으면 현재 탭의 전체 페이지 사진도 본문, 최근 요청 일부와 함께 OpenAI에 보냅니다. 입력란과 내장 문서, 감지된 개인정보는 가립니다. 그림 속 개인정보는 남을 수 있습니다. 글로만 들으려면 “사진 없이 화면 설명해 줘”라고 하세요. ") +
    "받은 파일에 대해 질문하거나 요약을 요청하면 파일 전체나 본문을 OpenAI 파일 분석 서버에 보낼 수 있습니다. 파일마다 보낼 곳을 알려 드리고 동의를 받습니다. " +
    `${voice} ${model} 비밀번호나 주민등록번호는 말하지 마세요. ` +
    "언제든 '멈춰'라고 말하면 멈춥니다. " +
    (background
      ? `동의하시면 ${mac ? "커맨드" : "컨트롤"}, 시프트, 스페이스 키를 함께 눌러 주세요. 동의하지 않으시면 메뉴 막대의 청음에서 종료를 고르세요.`
      : "동의하시면 Enter를, 동의하지 않으시면 Escape를 눌러 주세요.")
  );
}
