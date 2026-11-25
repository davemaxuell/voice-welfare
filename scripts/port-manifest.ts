import { readFileSync } from "node:fs";
import { z } from "zod";

const repoPath = z.string().regex(/^(?!\/)(?!.*\.\.)(?!.*[\\:*?\[]).+$/u);
const schema = z.object({
  reference: z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/u), collection: repoPath }),
  modules: z.record(repoPath, z.object({
    python: z.array(repoPath).min(1),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/u),
    // 한 모듈에서 큐나 비교 알고리즘만 가져온 경우에도 원본 변경은 추적한다.
    partial: z.literal(true).optional(),
  })),
});

export const { modules, reference } = schema.parse(JSON.parse(readFileSync(new URL("./migration/port-manifest.json", import.meta.url), "utf8")));
export const portedSources = new Set(Object.values(modules).flatMap(entry => entry.partial === true ? [] : entry.python));

export const partialSources = new Set(Object.values(modules).flatMap(entry => entry.partial === true ? entry.python : []));
