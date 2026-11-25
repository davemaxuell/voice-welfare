import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { readCsv } from "../src/agents/welfare/open_data/sync.ts";
import { REPO_ROOT } from "../src/core/assets.ts";

const catalog = join(REPO_ROOT, "scripts", "welfare-catalog");
const checkpoints = join(catalog, "preview_checkpoints");

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) { super("HTTP " + status); this.status = status; }
}

async function get(url: string) {
  await delay(1500);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; public-data-research)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.text();
}

export async function previewRows(page: Page, html: string): Promise<string[][] | undefined> {
  // Parse the official preview in a detached document. Its markup never joins the active page.
  const rows = await page.evaluate(source => {
    const doc = new DOMParser().parseFromString(source, "text/html");
    return Array.from(doc.querySelectorAll("tr"), row => Array.from(row.cells, cell => cell.textContent.trim()));
  }, html);
  const [header, ...data] = rows.filter(row => row.length > 0);
  if (header === undefined || header.length < 2 || (header.length === 2 && header[0] === "데이터명" && header[1] === "등록일")) return;
  const valid = data.filter(row => row.length === header.length).slice(0, 3);
  if (valid.length > 0) return [header, ...valid];
}

export function downloadKey(html: string, datasetId: string) {
  if (!/^\d+$/u.test(datasetId)) return undefined;
  return new RegExp(`fn_fileDataDown\\([\\p{White_Space}\\u001c-\\u001f]*['"]${datasetId}['"],[\\p{White_Space}\\u001c-\\u001f]*['"]([^'"]+)`, "u").exec(html)?.[1];
}

interface Checkpoint {
  id: string; source: string; retrieved_at: string; rows: string[][] | null;
  status: "verified" | "unavailable"; reason?: string; preview_url?: string; sample_type?: string;
}

async function main() {
  const { values } = parseArgs({ options: { limit: { type: "string", default: "100" }, help: { type: "boolean", short: "h" } } });
  if (values.help === true) { console.log("node scripts/collect-previews.ts [--limit 100]"); return 0; }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 0) { console.error("--limit must be a non-negative integer"); return 2; }
  const source = await readFile(join(catalog, "welfare_inventory.csv"), "utf8");
  const [header, ...raw] = readCsv(source.replace(/^\ufeff/u, ""));
  if (header === undefined) throw Error("Missing welfare inventory header");
  const inventory = raw.map(cells => Object.fromEntries(header.map((k, i) => [k, cells[i] ?? ""])));
  inventory.sort((a, b) => {
    const priority = Number(!a.scope_tier!.startsWith("Core")) - Number(!b.scope_tier!.startsWith("Core"));
    if (priority !== 0) return priority;
    return a.dataset_id! < b.dataset_id! ? -1 : a.dataset_id === b.dataset_id ? 0 : 1;
  });
  const seen = new Set<string>();
  const todo = inventory.filter(r => {
    const id = r.dataset_id!;
    if (seen.has(id)) return false;
    seen.add(id);
    return r.sample_data === "" && r.catalog_type === "FILE" && r.format!.toLowerCase().includes("csv")
      && !existsSync(join(checkpoints, id + ".json"));
  }).slice(0, limit);
  await mkdir(checkpoints, { recursive: true });
  let browser: Browser | undefined;
  let parser: Page | undefined;
  try {
    for (const record of todo) {
      const id = record.dataset_id!;
      if (!/^\d+$/u.test(id)) throw Error("Invalid public dataset ID " + id);
      const checkpoint: Checkpoint = { id, source: record.source_url!, retrieved_at: new Date().toISOString(), rows: null, status: "unavailable" };
      let stop: number | undefined;
      try {
        const detail = await get(checkpoint.source);
        const key = downloadKey(detail, id);
        if (key === undefined) checkpoint.reason = "No public file download detail key exposed on detail page";
        else {
          const query = new URLSearchParams({ publicDataPk: id, publicDataDetailPk: key });
          checkpoint.preview_url = "https://www.data.go.kr/tcs/dss/selectHistAndCsvData.do?" + query.toString();
          const html = await get(checkpoint.preview_url);
          if (parser === undefined) {
            browser = await chromium.launch();
            parser = await browser.newPage();
            await parser.route("**/*", route => route.abort());
          }
          const rows = await previewRows(parser, html);
          if (rows === undefined) checkpoint.reason = "No tabular public data preview found; not a fabricated example";
          else { checkpoint.rows = rows; checkpoint.status = "verified"; checkpoint.sample_type = "official public file preview"; }
        }
      } catch (error) {
        checkpoint.reason = error instanceof Error ? error.message : String(error);
        if (error instanceof HttpError && [403, 429].includes(error.status)) stop = error.status;
      }
      await writeFile(join(checkpoints, id + ".json"), JSON.stringify(checkpoint, null, 2));
      if (stop !== undefined) { console.log("STOP restriction", id, stop); break; }
      console.log(id, checkpoint.status);
    }
  } finally { await browser?.close(); }
  return 0;
}
if (import.meta.main) process.exitCode = await main();
