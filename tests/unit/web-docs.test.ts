import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, it } from "vitest";
import { readDocument } from "../../src/agents/web/docs.ts";
import { DownloadStore } from "../../src/agents/web/downloads.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { checkGrounding } from "../../src/safety/verify.ts";

const folders: string[] = [];
function file(name: string, content: Uint8Array | string) {
  const folder = mkdtempSync(join(tmpdir(), "cheongeum-doc-"));
  folders.push(folder);
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function hwpx(text: string) {
  return file("안내.hwpx", zipSync({ "Contents/section0.xml": strToU8(
    `<?xml version="1.0"?><root xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${text}</root>`
  ) }));
}
it("test_read_hwp_refused", async () => {
  expect(await readDocument(file("a.hwp", "old-hwp"))).toMatchObject({ok:false,kind:"hwp",speech: expect.stringContaining("HWPX")});
});
it("test_read_hwpx", async () => {
  expect(await readDocument(hwpx("<hp:t>장애인</hp:t><hp:t>연금</hp:t>"))).toMatchObject({ok:true,kind:"hwpx",text:"장애인연금"});
});
it("test_read_pdf_kind", async () => {
  // 간단한 한 쪽 PDF. 본문을 근거 확인에도 그대로 사용한다.
  const stream = "BT /F1 12 Tf 25 200 Td (Welfare office 129) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${obj}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10,"0")+" 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const result = await readDocument(file("b.pdf", pdf));
  expect(result).toMatchObject({ok:true,kind:"pdf",text:"Welfare office 129"});
  if (!result.ok) throw Error(result.speech);
  expect(checkGrounding({answer:"129", quotes:["Welfare office 129"], sources:[result.text]}).ok).toBe(true);
});
it("test_download_store_read", async () => {
  const store = new DownloadStore();
  store.remember(hwpx("<t>안내문</t>"));
  expect(await store.readLatest()).toContain("안내문");
  expect(store.listNames()).toEqual(["안내.hwpx"]);
});
it("test_parse_read_download", () => {
  const parser = new RuleBasedIntentProvider([]);
  expect(parser.parseSync("받은 파일 읽어줘",{state:"IDLE"}).type).toBe("READ_DOWNLOAD");
  expect(parser.parseSync("받은 파일 목록",{state:"IDLE"})).toMatchObject({type:"READ_DOWNLOAD",list:true});
});
