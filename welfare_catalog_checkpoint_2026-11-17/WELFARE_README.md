# Korea public-data portal: welfare inventory

## Scope and provenance
This is a focused welfare inventory, not a scrape of every underlying data record. It uses the official bulk catalog `공공데이터활용지원센터_공공데이터포털 목록개방현황_20261031`, published/modified 2026-11-05, plus the official schema catalog titled `행정안전부_공공데이터포털 목록 메타정보_20260703`.

- Monthly source: https://www.data.go.kr/data/15062804/fileData.do
- Schema source: https://www.data.go.kr/data/15121937/fileData.do
- Retrieved in this run: 2026-11-17 UTC.

The monthly source's filename indicates October 31, while its temporal-coverage text says through September. The source's reported totals also need comparison with actual file rows. Use the verified counts in welfare_stats.json, not page labels alone. These are official snapshots, not proof of every currently available dataset.

## Inclusion
Core records have an official classification starting with 사회복지. Expanded records contain explicit welfare, vulnerable-population, care, social-insurance or related terms in their dataset subject (provider prefix removed) or keywords. Exact terms and tier counts are in welfare_stats.json. Expanded entries deliberately include adjacent subjects, such as child services, long-term care, health insurance and public pensions, and may need manual relevance review. No claimed semantic exhaustiveness.

## Fields and join
The CSV preserves original Korean descriptions and field names for fidelity, with English column labels. It provides descriptions, formats, reported row counts, access methods, licenses, limits, original URLs, and available request/output field names. Schema entries join on exact dataset ID AND catalog type; multiple matching schema strings are preserved with ` || ` separators. A matching annual schema may predate the monthly catalog. Blank fields mean unavailable in the source, not that the dataset has no fields.

Annual CSV has records with blank IDs/invalid types which look like field-list continuation lines. These are excluded as independent datasets; the preceding matching entry is flagged for verification. Counts of excluded rows appear in the statistics. Never treat a column list, catalog description, documentation placeholder or API request parameter as a real data sample.

## Examples and access
`sample_status=Not retrieved; metadata only` means no actual data row was fetched for that entry. Actual verified preview rows are supplied separately by dataset ID when available. No sample values are fabricated. Public file previews may be stale or represent only the beginning of a file. API documentation samples are not proof of a successful live API call.

File downloads do not require login according to the portal. Open APIs generally require a service key and usage application, sometimes provider approval, and have per-service request limits. No API applications, permission changes, account changes or paid purchases were performed. A complete real-example sweep would require retrieving every file/preview or using authorized APIs, and cannot be inferred from this metadata inventory.


## Recommended reading order
Start with **welfare_core.csv**, 5,533 officially classified social-welfare records. **welfare_related_candidates.csv** contains 4,769 broad keyword candidates and is not a validated welfare-only list. Some are indirect (for example, youth science/astronomy teaching materials) because an explicit population keyword matches. The combined inventory has 10,302 records. These counts are dataset-list records, not downloads or verified samples. This split is intentional so unrelated keyword matches do not masquerade as confirmed welfare data.

The downloaded monthly bulk CSV contains exactly 103,114 unique IDs, matching its page-reported row count. The annual schema CSV contains 108,234 parsed rows; 50 invalid-ID/type rows were excluded. This differs from its page-reported 68,943 rows, so its filename date and metadata are not a reliable completeness guarantee. The raw official source remains unchanged for audit.
