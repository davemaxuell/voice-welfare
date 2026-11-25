# Welfare data: eight verified real sample records

These are real rows from official public file previews, not synthetic examples or API documentation defaults. The three-row extracts and source field definitions are preserved in the companion JSON. Preview rows are bounded excerpts and do not establish full-file completeness or newest observation. All eight listings expose CSV data; collection required no account change or API application.

## Senior welfare centers: 경기도 성남시_노인_종합복지관_현황 (15000901)
[Official dataset](https://www.data.go.kr/data/15000901/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:12.223971+00:00

Facility name, address, opening date, floor area (m²), floor configuration, services, contact and reference date. Useful for locating elderly community services, not determining eligibility or live capacity.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 복지관명 | 수정노인종합복지관 |
| 소재지 | 경기도 성남시 수정구 수정남로 268번길 28(산성동) |
| 설치일자 | 1997-09-25 |
| 시설면적(제곱미터) | 4493 |
| 시설규모2 | 지하1+지상4 |
| 주요사업 | 노인여가복지 프로그램+경로식당 |
| 전화번호 | 031-731-3393 |
| 데이터기준일자 | 2026-06-03 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Disability allowance beneficiaries: 보건복지부_장애수당 수급자 현황_시도별 (15001632)
[Official dataset](https://www.data.go.kr/data/15001632/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:12.261415+00:00

Year and province, with separate recipient counts for livelihood/medical benefit recipients living outside/inside facilities and the near-poor/education/housing benefit group. These are disability-allowance counts, not all registered disabled people or disability-pension recipients.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 연도 | 2018 |
| 시도 | 서울Seoul |
| 기초생활보장 생계_의료급여 수급자(일반) | 37736 |
| 기초생활보장 생계_의료급여 수급자(시설) | 1114 |
| 차상위 및 기초생활보장 교육_주거급여 수급자 | 14138 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Basic livelihood security beneficiaries: 보건복지부_기초생활보장 수급자 수_시도별 (15001654)
[Official dataset](https://www.data.go.kr/data/15001654/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:20.537991+00:00

Year/province plus ordinary-recipient households, ordinary-recipient persons and institutional-recipient persons. Household counts and person counts must not be summed together.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 연도 | 2018 |
| 시도 | 서울 Seoul |
| 일반수급자 가구 | 197278 |
| 일반수급자 인원 | 277991 |
| 시설수급자 인원 | 11351 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Childcare facilities: 서울특별시 종로구_어린이집 (15002386)
[Official dataset](https://www.data.go.kr/data/15002386/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:20.493185+00:00

Name/type, address/contact, licensed capacity (정원), enrolled children (현원), coordinates, school-bus operation, authorization date, reference date and service category. Capacity minus enrollment is not verified current vacancy.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 어린이집명 | LX광화문어린이집 |
| 어린이집유형 | 직장 |
| 상세주소 | 서울특별시 종로구 신문로2가 새문안로 58 |
| 전화번호 | 070-4065-0286 |
| 정원 | 40 |
| 현원 | 14 |
| 시설 위도(좌표값) | 37.56927522 |
| 시설 경도(좌표값) | 126.9715792 |
| 통학차량운영여부 | 미운영 |
| 인가일자 | 2026-03-06 |
| 데이터기준일자 | 2026-09-15 |
| 제공서비스 | 일반 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Homelessness residential facilities: 보건복지부_노숙인 생활시설 수 및 생활인원 현황_시도별 (15004402)
[Official dataset](https://www.data.go.kr/data/15004402/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:30.269582+00:00

Year/province, facility count, admissions by route, exits by reason and year-end resident breakdowns. Admissions/exits are flows; year-end residents are stocks. Sex and disability breakdowns are overlapping descriptions of the same population, not additive groups.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 연도 | 2018 |
| 시도 | 서울 Seoul |
| 시설수 | 37 |
| 입소자(행정기관의뢰) | 63 |
| 입소자(전입) | 817 |
| 입소자(기타) | 153 |
| 퇴소자(연고자인도) | 91 |
| 퇴소자(직업자활) | 249 |
| 퇴소자(전원) | 118 |
| 퇴소자(무단퇴소) | 372 |
| 퇴소자(사망) | 75 |
| 퇴소자(기타) | 254 |
| 연말기준 생활자(남) | 1902 |
| 연말기준 생활자(여) | 797 |
| 연말기준 생활자(비장애인) | 1755 |
| 연말기준 생활자(정신질환) | 481 |
| 연말기준 생활자(지체장애) | 124 |
| 연말기준 생활자(시각장애) | 24 |
| 연말기준 생활자(언어청각) | 27 |
| 연말기준 생활자(지적장애) | 265 |
| 연말기준 생활자(기타) | 23 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Low-income single-parent families: 경기도 성남시_저소득_한부모가족_현황 (15004898)
[Official dataset](https://www.data.go.kr/data/15004898/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:29.589323+00:00

District/neighborhood plus households and members, separated into mother-child and father-child families, with reference date. These are aggregate counts, not individual benefit records.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 구별 | 수정구 |
| 동별 | 신흥1동 |
| 한부모가족_세대수 | 65 |
| 한부모가족_가구원수 | 157 |
| 모자가족_세대수 | 55 |
| 모자가족_가구원수 | 134 |
| 부자가족_세대수 | 10 |
| 부자가족_가구원수 | 23 |
| 데이터기준일자 | 2026-05-31 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Disability welfare facilities: 부산광역시_북구_장애인 복지시설 현황 (15005945)
[Official dataset](https://www.data.go.kr/data/15005945/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:38.597330+00:00

Facility category, name/address, director, resident/user count, operating start date and contact. Facility count/use population does not establish capacity or individual eligibility.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 구분 | 생활시설 |
| 시설명 | 평화의집 |
| 주소 | 부산광역시 북구 양달로 65 (화명동) |
| 시설장 | 정영희 |
| 생활(이용)인원 | 50 |
| 운영시작일자 | 2000-12-11 |
| 전화번호 | 051-331-4344 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.

## Community childcare centers: 보건복지부_지역아동센터 현황 (15004404)
[Official dataset](https://www.data.go.kr/data/15004404/fileData.do) · Format: CSV · Retrieved: 2026-11-17T16:35:38.617224+00:00

Year, facility count, users by school-stage category, and director/social-welfare-worker counts. Older years appear first in this preview; they are genuine historical records, not current-year claims.

License recorded by portal: 이용허락범위 제한 없음.

**Actual first preview record:**

| Source column | Actual value |
|---|---|
| 연도 | 2006 |
| 시설수 | 2029 |
| 미취학 | 4133 |
| 초등학교저학년 | 25149 |
| 초등학교고학년 | 21426 |
| 중학생 | 6846 |
| 고등학생 | 1095 |
| 학교밖 | 103 |
| 기타 | 420 |
| 종사자 현황_시설장 | 2019 |
| 종사자 현황_생활복지사 | 2961 |

The source description and exact field definitions are retained in the JSON, along with the preview endpoint and three records.
