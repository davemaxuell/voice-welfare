# Optional reproducible preview collection

From the project root, run `node scripts/collect-previews.ts --limit 100` with the project dependencies and Playwright Chromium installed. The command reads the report's `welfare_inventory.csv`, prioritizes core welfare CSVs, skips existing checkpoints and verified samples, and writes `preview_checkpoints/{dataset_id}.json` alongside the inventory.

The collector reads public pages one request at a time, with a 1.5-second delay and a 30-second timeout. It stops on HTTP 403 or 429. Unavailable checkpoints stay on disk. The collector ignores non-CSV formats, APIs and historical-version tables. A missing preview leaves the availability of the underlying data unknown. Check the relevance and privacy of each recorded sample before use.
