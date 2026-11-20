// 녹음 파일 받아쓰기 칸의 글. src/cheongeum/web/static/recording-review.js에서 그대로 옮겼다.
export const copy: Readonly<Partial<Record<string, readonly string[]>>> = {
    ko: ['녹음 파일 받아쓰기', '녹음 파일 선택 (최대 10 MiB)', '음성 API에 보내 받아쓰기', '받아쓴 내용', '받아쓰는 중…', '녹음 파일의 형식과 크기를 확인해 주세요.', '받아썼어요. 내용을 읽거나 복사할 수 있어요.', '받아쓰지 못했어요. 파일과 음성 API 설정을 확인해 주세요.'],
    en: ['Transcribe a recording', 'Choose an audio file (up to 10 MiB)', 'Send to the speech API for transcription', 'Transcript', 'Transcribing…', 'Check the file format and size.', 'Transcript ready to read or copy.', 'Transcription failed. Check the file and your voice API settings.'],
    zh: ['转写录音', '选择音频文件（最大 10 MiB）', '发送至语音 API 转写', '转写文本', '正在转写…', '请检查文件格式和大小。', '转写已完成，可以阅读或复制。', '转写失败。请检查文件和语音 API 设置。'],
    ja: ['録音を文字に起こす', '音声ファイルを選択（最大 10 MiB）', '音声 API に送って書き起こす', '書き起こした内容', '書き起こしています…', 'ファイルの形式とサイズを確認してください。', '書き起こしが終わりました。内容を読んだりコピーしたりできます。', '書き起こせませんでした。ファイルと音声 API の設定を確認してください。'],
};
