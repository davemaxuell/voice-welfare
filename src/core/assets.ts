import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ASSET_ROOT = join(REPO_ROOT, "src");
export const browserAsset = (file: string) => join(ASSET_ROOT, "agents/web/browser", file);
export const practiceSite = join(ASSET_ROOT, "practice_site/site");
export const welfareData = join(ASSET_ROOT, "agents/welfare/data");
export const welfareSnapshots = join(ASSET_ROOT, "agents/welfare/open_data/snapshots");
export const evaluationData = join(ASSET_ROOT, "evaluation/data");
export const webStatic = join(REPO_ROOT, "dist/web");
export const soundCues = join(REPO_ROOT, "web/public/cues");
export const axeScript = join(REPO_ROOT, "scripts/vendor/axe.min.js");
export const models = join(REPO_ROOT, "models");
