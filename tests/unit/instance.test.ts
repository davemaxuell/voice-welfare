import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ownInstance } from "../../src/server/instance.ts";

it("같은 사용자의 다른 실행 경로에서 기존 창을 활성화하고 종료 후 다시 획득한다", async () => {
  const profile = randomUUID();
  const focus = vi.fn();
  const owner = await ownInstance(focus, profile);
  try {
    expect(owner).toBeDefined();
    expect(await ownInstance(() => { throw new Error("secondary started"); }, profile)).toBeUndefined();
    expect(focus).toHaveBeenCalledOnce();
  } finally { await owner?.close(); }
  await (await ownInstance(focus, profile))?.close();
});
