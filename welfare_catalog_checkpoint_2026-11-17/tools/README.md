# Optional reproducible preview collection

Python 3 standard library only. Unzip the report, then run `python tools/collect_previews.py --limit 100` from any directory. The script reads `welfare_inventory.csv` beside this folder, prioritizes core welfare CSVs, skips existing checkpoint files and previously verified samples, and writes `preview_checkpoints/{dataset_id}.json`.

It performs only public reads, no account login or API application. Requests are single-threaded with a 1.5-second delay and a 30-second timeout; it stops on HTTP 403 or 429. A checkpoint marked unavailable is not automatically retried. Other formats and APIs are deliberately skipped. An absent preview is not evidence that the underlying data is unavailable. Outputs require human relevance/privacy validation before use; historical-version tables are rejected. Do not increase traffic aggressively or evade restrictions.
