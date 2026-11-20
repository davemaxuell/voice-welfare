# Welfare data on Korea’s Public Data Portal

## What is delivered
A searchable inventory of **5,533 officially classified social-welfare datasets**, plus a separate appendix of **4,769 welfare-related keyword candidates**. The candidate appendix is not a claim that all records directly concern welfare. Some population-keyword matches are indirect, such as youth education materials.

The main catalog records are in `welfare_core.csv`. Start there. `welfare_related_candidates.csv` is optional; `welfare_inventory.csv` combines both, with an explicit scope tier and rationale. Original Korean descriptions are retained rather than replaced with speculative summaries.

## Coverage
- Official monthly snapshot: **103,114 unique catalog IDs**, downloaded and parsed completely. Filename date: **2026-10-31**; source modified **2026-11-05**.
- Welfare core and candidate inventory combined: **10,302 records**.
- Actual official preview examples verified: **163 records**, not the whole inventory.
- Attempted but no usable preview: **9 records**.
- Example not yet attempted: **10,130 records**.
- Schema/field-list metadata available: **6,333 records**.

Every row includes title, description, format, source URL, provider, category, access method, license/fee information, limitations, and available request/output fields. `sample_data` stores a header row and up to three real data rows as JSON, preserving original values. `sample_status` distinguishes verified previews, failed attempts, and unattempted entries. A metadata description or a historical file-version list is not treated as an actual sample.

## Official social-welfare category breakdown

| Category | Catalog records |
|---|---:|
| 사회복지 - 사회복지일반 | 2,033 |
| 사회복지 - 보육·가족및여성 | 1,208 |
| 사회복지 - 노인·청소년 | 1,164 |
| 사회복지 - 취약계층지원 | 551 |
| 사회복지 - 공적연금 | 444 |
| 사회복지 - 기초생활보장 | 133 |

## Representative actual examples
The separate `welfare_verified_examples.md` explains eight checked facility, care, disability and support datasets. Many additional preview records are included directly in the inventory, each with its source URL and retrieval timestamp. These are real public preview values, not synthetic examples. Preview rows do not prove the entire underlying file was downloaded or validate every record in that file.

## Important limitations
- **Not a live exhaustive sweep:** the monthly source is a dated official snapshot. Its temporal-coverage description says September despite an October filename. Latest changes after the snapshot are not reconciled.
- **Schema source anomaly:** annual schema metadata names July 2026 and reports 68,943 rows on its webpage, but the downloaded file parses to 108,234 rows. Fifty invalid-ID/type continuation records were excluded; affected entries are flagged. It is joined by ID and type and is not assumed current.
- **No fake examples:** unavailable API responses, missing previews, other formats, and unattempted records remain explicitly unfilled.
- **API permission is separate:** no API usage applications, service-key operations, account changes, purchases or downloads requiring new permissions were made. Login alone is not universal API authorization.
- **Format-specific work remains:** Excel/PDF/geospatial/media files and APIs need different extraction; public CSV preview coverage alone cannot satisfy every record.
- **Relevance:** official social-welfare classification is the reliable main scope. Related candidates need manual review before benchmark inclusion.
- **Use conditions vary:** check each record’s license and conditions; publicly listed does not mean unrestricted use in every context.

## Sources
- Official monthly full metadata catalog: https://www.data.go.kr/data/15062804/fileData.do
- Official request/output schema catalog: https://www.data.go.kr/data/15121937/fileData.do
- Each included dataset has its own `source_url`; verified previews also carry `sample_source_url` and timestamps.

## Reproducibility
`tools/collect_previews.py` is an optional Python-standard-library collector for a responsibly paced continuation. It checkpoints each attempted public CSV preview, skips already verified/checkpointed records, and stops on HTTP 403/429. It does not bypass access restrictions or claim unsuccessful requests as samples.

## Collection checkpoint
The collector is stopped, not running. Its last recorded request failed with a proxy-tunnel 403; the process was absent at the follow-up check. It was not restarted or bypassed. The core inventory has 163 verified samples, 9 attempted/unavailable samples, and 5,361 unattempted records. Metadata-only enrichment notes for IDs 15083323 and 15173720 are included separately, not represented as real data rows.
