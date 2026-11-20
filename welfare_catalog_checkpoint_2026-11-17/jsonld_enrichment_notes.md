# Welfare metadata enrichment: two verified records

Checked 2026-11-17 using public official structured metadata. This is metadata only, not evidence of retrieved data rows. Both IDs already exist in the inventory; do not add duplicate datasets.

## 15083323: 한국사회보장정보원_복지서비스정보
- Source: https://www.data.go.kr/catalog/15083323/fileData.json
- Existing inventory: core welfare; all 10 schema names already present.
- Useful additional schema meanings: 서비스아이디 = service ID; 서비스URL = Bokjiro detail URL; 서비스요약 = service overview; 사이트 = related website; 대표문의 = contact point; 소관부처명 = responsible ministry/department; 소관조직명 = responsible organizational unit.
- CSV, annual update; source alternate name dates snapshot to 2026-08-19 and modification date to 2026-09-10.
- Provider explicitly warns that the snapshot may differ from current Bokjiro information. Do not treat it as current eligibility guidance.

## 15173720: 국민건강보험공단_통합돌봄 서비스 자원
- Source: https://www.data.go.kr/catalog/15173720/fileData.json
- Existing inventory: expanded welfare candidate, with no matching annual schema. It is directly relevant to welfare/care services.
- Verified eight-column schema, in source order: 시도, 시군구, 서비스 제공기관명, 기관연락처, 기관주소, 대분류, 중분류, 프로그램명칭.
- CSV; source labels update cadence 수시 (1회성 데이터). Snapshot 2026-06-30; published 2026-10-19 and modified 2026-10-21. Roughly 90,000 service resources, not individual beneficiaries.
- Classification discrepancy: bulk inventory says 보건의료 - 보건의료; current JSON-LD says 사회복지 - 보건의료. Preserve both with provenance rather than silently changing the original snapshot classification.
- Description refers to 소분류, while published schema says 중분류. Preserve source header; do not silently normalize these into one concept.

## Integration and continuation
The sidecar JSON contains an eight-field schema fill for 15173720, leaving sample status untouched. No crawler process or master inventory was changed. Public web retrieval successfully reads these metadata endpoints; it does not prove authenticated downloads or previews are accessible. A safe next batch can enrich missing schemas through the supported web tool, but must never count metadata as real samples. The stopped preview collector should remain stopped until its network access is confirmed permitted.
