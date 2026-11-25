import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { denyProxy } from "./network.mjs";

// Chrome는 경로(Windows는 UTF-16)를 해시해 압축을 풀어 둔 확장의 ID를 만든다.
const extension = await realpath(join(dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "extension"));
const extensionId = [...createHash("sha256").update(Buffer.from(extension + sep, process.platform === "win32" ? "utf16le" : "utf8"))
  .digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");

export async function attached(launch, options, { persistentDir, model, liveProxy } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "cheongeum-stagehand-"));
  const netLog = join(folder, "netlog.json");
  const proxy = liveProxy ?? await denyProxy();
  let resource, handle, stagehand, control;
  try {
    resource = await launch({
      ...options, channel: "chromium", headless: true,
      ignoreDefaultArgs: [...(options.ignoreDefaultArgs ?? []), "--disable-extensions"],
      args: [...(options.args ?? []), "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--enable-automation", "--enable-unsafe-extension-debugging", "--remote-allow-origins=chrome-extension://" + extensionId,
        "--proxy-server=http://127.0.0.1:" + proxy.port, "--disable-quic",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
        "--disable-component-update", "--disable-domain-reliability", "--disable-background-networking",
        "--disable-sync", "--no-pings", "--log-net-log=" + netLog],
    });
    const pw = resource.newContext ? resource : resource.browser();
    control = await pw.newBrowserCDPSession();
    const command = await control.send("Browser.getBrowserCommandLine");
    const profile = persistentDir ?? command.arguments.find(arg => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    const port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
    assert(port > 0);
    const cdpUrl = "http://127.0.0.1:" + port;
    // 임시 프로필에서만 시크릿 컨텍스트 권한을 명시해, 세션별 쿠키 분리를 유지한다.
    const installed = await control.send("Extensions.loadUnpacked", { path: extension + sep, enableInIncognito: true });
    assert.equal(installed.id, extensionId);
    handle = await localBrowser.connect({ cdpUrl });
    stagehand = await Stagehand.create({ browser: handle, selfHeal: false, cache: false, model,
      logging: { level: "error" } });
    assert(handle.connected && handle.origin === "connected" && stagehand.initialized);
    await stagehand.metrics();
    const targets = await control.send("Target.getTargets");
    assert(targets.targetInfos.some(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://" + extensionId + "/")));
    await control.detach();
    console.log("STAGEHAND_ATTACHED", JSON.stringify({ chromium: pw.version(), extensionId, cdp: "127.0.0.1", port, persistent: !!persistentDir }));
    return { resource, stagehand, handle, netLog, folder, proxy, async detach() {
      await stagehand.close();
      await handle.disconnect();
    }};
  } catch (error) {
    await control?.detach().catch(() => {});
    await handle?.disconnect().catch(() => {});
    await resource?.close();
    if (!liveProxy) await proxy.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
