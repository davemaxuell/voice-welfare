import { createHash } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { textOr } from "../core/text.ts";

/** 데스크톱과 명령줄에서 HTTP 포트를 다르게 써도 한 사용자의 실행 창을 찾아간다. */
export async function ownInstance(activate: () => void, profile = textOr(process.env.NODE_ENV === "test" ? process.env.CHEONGEUM_SETTINGS_DIR : undefined, homedir())) {
  const name = "cheongeum-" + createHash("sha256").update(profile).digest("hex").slice(0, 24);
  let path = "\\\\.\\pipe\\" + name;
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    const directory = join(tmpdir(), "cheongeum-" + String(uid));
    await mkdir(directory, {recursive: true, mode: 0o700});
    const owner = await lstat(directory);
    if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o077) !== 0) throw new Error("사용자 전용 연결 폴더에 접근할 수 없어요.");
    path = join(directory, name + ".sock");
  }
  const server = createServer(socket => {
    socket.on("error", () => {});
    activate();
    socket.end("activated");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    try {
      await new Promise<void>((resolve, reject) => {
        const client = createConnection(path);
        let reply = "";
        client.setEncoding("utf8").on("data", (chunk: string) => { reply += chunk; });
        client.on("error", reject);
        client.once("end", () => reply === "activated" ? resolve() : reject(new Error("실행 중인 청음 창을 확인하지 못했어요.")));
      });
    } catch (failure) {
      // 실행 창을 찾는 사이에 먼저 연 앱이 종료되었으면 같은 주소로 다시 연결한다.
      const code = (failure as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return await ownInstance(activate, profile);
      if (process.platform === "win32" || code !== "ECONNREFUSED") throw failure;
      const socket = await lstat(path);
      if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw failure;
      await unlink(path);
      return await ownInstance(activate, profile);
    }
    return undefined;
  }
  return { close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
