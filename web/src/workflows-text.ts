// 자료 조사·메모 칸의 글. src/cheongeum/web/static/workflows.js에서 그대로 옮겼다.
export const copy: Readonly<Partial<Record<string, readonly string[]>>> = {
  ko: ['자료 조사와 저장한 메모', '공개 자료에서 확인할 질문', '이 질문과 결과를 저장하고 앱을 다시 열어도 조사를 이어가는 데 동의해요.', '조사 맡기기', '기억할 선호 사항이나 찾을 내용', '이 메모를 저장하고 관련 질문과 함께 OpenAI에서 검색해 대화에 활용하는 데 동의해요.', '메모 저장', '메모 찾기', '전체 보기', '중단', '삭제', '질문 수정', '저장하거나 검색할 내용을 확인해 주세요. 개인 연락처나 인증 정보는 빼 주세요.', '관련 메모가 없어요.', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.', '완료한 조사나 메모를 삭제하고 다시 시도해 주세요.', '변경 사항을 저장했어요.'],
  en: ['Research and saved notes', 'Question for public sources', 'Save this question and its results, and continue the research when I reopen the app.', 'Start research', 'Preference to remember or terms to find', 'Save this note and use OpenAI to match it with relevant questions during conversations.', 'Save note', 'Find notes', 'Show all', 'Cancel', 'Delete', 'Revise question', 'Check the text and remove personal contact details or credentials.', 'No matching notes.', 'The request failed. Please try again.', 'Delete a finished lookup or note and try again.', 'Changes saved.'],
  zh: ['资料调查和已存笔记', '要查阅公开资料的问题', '同意保存问题和结果，重新打开应用时继续调查。', '开始调查', '要记住的偏好或要搜索的词', '同意保存此笔记，并在对话中通过 OpenAI 与相关问题进行匹配。', '保存笔记', '查找笔记', '显示全部', '取消', '删除', '修改问题', '请检查输入，删除个人联系方式或认证信息。', '没有匹配的笔记。', '请求失败，请稍后再试。', '请删除已结束的调查或笔记后再试。', '更改已保存。'],
  ja: ['資料調査と保存したメモ', '公開資料で調べる質問', '質問と結果を保存し、アプリを再度開いたときも調査を続けることに同意します。', '調査を依頼', '覚えておく希望や検索語', 'このメモの保存と、会話中に OpenAI で関連する質問と照合することに同意します。', 'メモを保存', 'メモを検索', 'すべて表示', '中止', '削除', '質問を修正', '入力を確認し、個人の連絡先や認証情報を削除してください。', '該当するメモはありません。', '処理できませんでした。もう一度お試しください。', '終了した調査やメモを削除してからお試しください。', '変更を保存しました。'],
};
export const states: Readonly<Partial<Record<string, readonly string[]>>> = {
  queued: ['접수됨', 'Queued', '排队中', '受付済み'], running: ['조사 중', 'Researching', '调查中', '調査中'],
  completed: ['조사 완료', 'Completed', '已完成', '調査完了'], partial: ['일부 확인', 'Partially verified', '部分已确认', '一部確認'],
  incomplete: ['확인하지 못함', 'Unverified', '未能确认', '未確認'], failed: ['실패', 'Failed', '失败', '失敗'],
  needs_input: ['질문 보완 필요', 'Clarification needed', '需要补充说明', '質問の補足が必要'], cancelled: ['중단됨', 'Cancelled', '已取消', '中止済み'],
};

export const resultCopy = {
  missing: ["확인이 남은 항목", "Still to verify", "待核实项目", "確認が残っている項目"],
  checked: ["출처 확인일", "Source checked", "核实日期", "出典の確認日"],
  unknownDate: ["날짜 기록 없음", "Date unavailable", "日期未知", "日付不明"],
  dataDate: ["자료 기준일", "Data date", "数据基准日期", "データ基準日"],
  live: ["기관 자료", "Agency data", "机构数据", "機関のデータ"],
  stored: ["저장 자료", "Stored data", "存档数据", "保存データ"],
  "private-program": ["민간 사업 자료", "Private program data", "民间项目数据", "民間制度のデータ"],
  answer: ["공개 정보로 답하기", "Reply with public information", "用公开信息回复", "公開情報で回答"],
  resume: ["조사 이어가기", "Continue research", "继续调查", "調査を続ける"],
  read: ["결과 듣기", "Read result aloud", "朗读结果", "結果を読み上げる"],
} as const;
