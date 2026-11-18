interface SpeechRecognizer {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
  onerror: (event: { error: string }) => void;
  onend: () => void;
  start(): void;
  stop(): void;
}
interface Window {
  webkitAudioContext?: typeof AudioContext;
  SpeechRecognition?: new () => SpeechRecognizer;
  webkitSpeechRecognition?: new () => SpeechRecognizer;
  cheongeumDesktop?: { onTalk(fn: () => void): void };
}
