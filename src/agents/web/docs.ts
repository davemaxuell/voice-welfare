import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { extractText } from "unpdf";
import { strip } from "../../core/text.ts";

export const documentPatterns = { lineEnd: /[ \t]+\n/gu, spaces: /\p{White_Space}+/gu };
type Kind = "pdf" | "hwpx" | "hwp" | "other";
export type DocumentRead = { ok: true; kind: "pdf" | "hwpx"; text: string; speech: string } |
  { ok: false; kind: Kind; speech: string };

async function pdfText(bytes: Uint8Array) {
  const { text } = await extractText(bytes, { mergePages: false });
  return text.join("\n").replace(documentPatterns.lineEnd, "\n");
}
type XmlNode = { [name: string]: XmlNode[] | string };
const xml = new XMLParser({ preserveOrder: true, removeNSPrefix: true, ignoreAttributes: true, trimValues: false, parseTagValue: false });

function words(bytes: Uint8Array, fallback: boolean) {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" :
    bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" :
    /<\?xml[^>]*encoding\s*=\s*["']([^"']+)/iu.exec(new TextDecoder().decode(bytes.subarray(0, 160)))?.[1] ?? "utf-8";
  let source;
  try { source = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { return []; }
  if (XMLValidator.validate(source) !== true) return [];
  const result: string[] = [];
  function visit(nodes: XmlNode[]) {
    for (const node of nodes) for (const [tag, children] of Object.entries(node)) {
      if (!Array.isArray(children) || tag.startsWith("?")) continue;
      const text = children[0]?.["#text"];
      if (typeof text === "string" && (fallback ? strip(text).length > 0 && (tag.length <= 3 || ["t","text","char"].includes(tag.toLowerCase())) :
          ["t","T","char","Char"].includes(tag))) result.push(text);
      visit(children);
    }
  }
  visit(xml.parse(source) as XmlNode[]);
  return result;
}
function hwpxText(bytes: Uint8Array) {
  const files = unzipSync(bytes, { filter: file => file.name.toLowerCase().endsWith(".xml") });
  const all = Object.keys(files);
  let sections = all.filter(name => name.toLowerCase().includes("section"));
  if (sections.length === 0) sections = all.filter(name => name.toLowerCase().includes("content"));
  sections.sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  let text = sections.flatMap(name => words(files[name]!, false)).join("");
  if (text.length === 0) text = all.flatMap(name => words(files[name]!, true)).join("");
  return strip(text.replace(documentPatterns.spaces, " "));
}
export async function readDocument(path: string, { maxChars = 8000 }: { maxChars?: number } = {}): Promise<DocumentRead> {
  if ((await stat(path).catch(() => undefined))?.isFile() !== true) return { ok: false, kind: "other", speech: "그 파일을 찾지 못했어요." };
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (extension === ".hwp") return { ok: false, kind: "hwp", speech: `'${name}'은 예전 한글 파일(HWP)이라 글자를 뽑지 못해요. HWPX나 PDF로 받아 주세요.` };
  if (extension !== ".pdf" && extension !== ".hwpx") return { ok: false, kind: "other", speech: `'${name}'은 아직 읽어 드리지 못하는 형식이에요. PDF나 HWPX만 돼요.` };
  const bytes = Uint8Array.from(await readFile(path));
  const kind = extension === ".pdf" ? "pdf" : "hwpx";
  const full = strip(kind === "pdf" ? await pdfText(bytes) : hwpxText(bytes));
  if (full.length === 0) return { ok: false, kind, speech: `'${name}'에서 글을 찾지 못했어요.` };
  const text = Array.from(full).slice(0, maxChars).join("");
  return { ok: true, kind, text, speech: text };
}
