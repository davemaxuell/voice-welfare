export function jsRound(value: number): number {
  return Math.floor(value + 0.5);
}

export function todayIso(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
