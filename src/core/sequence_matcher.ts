/** CPython 3.12 difflib.SequenceMatcher에서 isjunk=None, autojunk=False인 경우를 옮겼다. 라이선스: third_party/CPython-LICENSE.txt */
export type Opcode = [tag: "equal" | "replace" | "delete" | "insert", i1: number, i2: number, j1: number, j2: number];
type Match = [i: number, j: number, length: number];
type Range = [alo: number, ahi: number, blo: number, bhi: number];

export function getOpcodes<T>(a: readonly T[], b: readonly T[]): Opcode[] {
  const positions = new Map<T, number[]>();
  b.forEach((item, index) => {
    const list = positions.get(item);
    if (list === undefined) positions.set(item, [index]);
    else list.push(index);
  });

  function longest([alo, ahi, blo, bhi]: Range): Match {
    let best: Match = [alo, blo, 0];
    let previous = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const lengths = new Map<number, number>();
      for (const j of positions.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const length = (previous.get(j - 1) ?? 0) + 1;
        lengths.set(j, length);
        if (length > best[2]) best = [i - length + 1, j - length + 1, length];
      }
      previous = lengths;
    }
    return best;
  }

  const queue: Range[] = [[0, a.length, 0, b.length]];
  const matches: Match[] = [];
  while (queue.length > 0) {
    const range = queue.pop()!;
    const [alo, ahi, blo, bhi] = range;
    const [i, j, size] = longest(range);
    if (size === 0) continue;
    matches.push([i, j, size]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
  }
  matches.sort(([i, j], [k, l]) => i === k ? j - l : i - k);
  const blocks: Match[] = [];
  for (const match of matches) {
    const last = blocks.at(-1);
    if (last !== undefined && last[0] + last[2] === match[0] && last[1] + last[2] === match[1]) {
      last[2] += match[2];
    } else {
      blocks.push(match);
    }
  }
  blocks.push([a.length, b.length, 0]);

  const opcodes: Opcode[] = [];
  let i = 0, j = 0;
  for (const [ai, bj, size] of blocks) {
    if (i < ai || j < bj) {
      const tag = i === ai ? "insert" : j === bj ? "delete" : "replace";
      opcodes.push([tag, i, ai, j, bj]);
    }
    i = ai + size;
    j = bj + size;
    if (size !== 0) opcodes.push(["equal", ai, i, bj, j]);
  }
  return opcodes;
}
