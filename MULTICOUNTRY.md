# Beyond Poland: harmonising regional statistics across CEE

Status: **foundations built and verified.** The geography spine and the PxWeb
adapter exist and work; the concept crosswalk is designed but not yet populated.

## Why this is worth doing

Eurostat's regional database effectively stops at NUTS-3. National statistical
offices publish far deeper — municipality (LAU) level — but each in its own
scheme, language and API. Harmonised **LAU-level** admin data across the region
does not currently exist.

## Architecture — three layers, never collapsed

```
facts_source      as published, untouched, always retained
      |           concept_map: explicit, human-confirmed, versioned
concept           POP_TOTAL, UNEMP_REG_RATE, ...
      |
facts_harmonized  + comparability tier (exact | close | indicative)
```

The rule that matters: **the pipeline never guesses at runtime.** Candidate
mappings may be *proposed* automatically (we have bilingual names and subject
trees to work from), but a human confirms each one and the tier is recorded.
The failure mode of auto-matching is not an error — it is a plausible-looking
wrong chart. BDL's "unemployment" is *registered* (administrative); most
comparators are LFS-based. Different concepts, similar names.

## 1. Geography spine — BUILT

`build_geo_spine.R` -> `geo_units.parquet`, `geo_validity.parquet`
`build_lau_nuts_xwalk.R` -> `lau_nuts_xwalk.parquet`

Sources: Eurostat GISCO (NUTS 7 vintages: 2003-2024; LAU 14 annual vintages:
2011-2024) plus the Eurostat LAU<->NUTS3 correspondence workbooks.

| classification | rows | distinct codes | countries |
|---|---|---|---|
| NUTS0-3 | 13,691 | 3,039 | 41 |
| LAU | 1,492,612 | 130,736 | 39 |

**Every unit is stored per vintage, and this is not pedantry:**

| | stable across all vintages | churned |
|---|---|---|
| NUTS | 1,095 | **1,944 (64%)** |
| LAU | 69,206 | **84,645 (55%)** |

LAU rows fall from 116,901 (2011) to 97,987 (2024) through mergers. Codes are
also reused. Treat a code as a fixed place and more than half your units are
wrong somewhere in the panel.

### National codes are NOT the EU codes
Each office uses its own scheme; mapping is a per-source rule, never a string
match. Poland, derived and verified:

```
eurostat_lau_code = '10' || substr(bdl_unitId, 1, 11)
```

Validated: **4,079 of 4,180 BDL gminy (97.6%)** join to Eurostat LAU, gaining
NUTS3 and DEGURBA. The ~2.4% gap is structural — BDL splits urban-rural gminas
into town/rural units that Eurostat carries as a single LAU.

## 2. PxWeb adapter — BUILT

`sources/pxweb.py`. One implementation covers several offices because they share
a contract:

```
GET  {base}/{lang}/{db}[/path]  -> navigation [{id, type:'l'|'t', text}]
GET  .../{table}                -> metadata {title, variables[]}
POST .../{table}                -> data as JSON-stat2
```

Verified working, unmodified, against:

| country | office | evidence |
|---|---|---|
| EE | Statistics Estonia | RV0291, 308-value geo dim, data round-trip |
| LV | Central Statistical Bureau | regional tables with 128 / 643 / 2,549-value geo dims |
| SI | Statistical Office | 213-value geo dim (212 municipalities + total) |

Slovakia (DATAcube) serves JSON-stat 2.0 but with different discovery/query —
a sibling adapter reusing the same JSON-stat normaliser.

### Gotchas the adapter already handles (found by probing, not assumed)
- On the `/en/` endpoint the variable **codes are still native-language**
  (Estonia: `Haldusüksus või asustusüksuse liik`); only `text` is English. Never
  key off code strings — classify dimensions by role.
- A table's geo dimension **mixes levels**: country, type-aggregates, counties
  and municipalities in one dimension, depth signalled by `..` label
  indentation. Level is inferred, not assumed.
- Not every table is regional; tables with no geo dimension are skipped.
- Geo values use each office's own scheme, never LAU codes.

## 3. Concept crosswalk — DESIGNED, not populated

```
concept      (concept_id, label_en, definition, unit, notes)
concept_map  (concept_id, source_id, source_var_id, comparability,
              transform, valid_years, notes)
```
`transform` covers the unglamorous but essential cases: unit scaling (persons
vs thousands), aggregation (male+female -> total), rate derivation (per 1000).
`comparability` is surfaced as a badge in the UI and a column in every export.

## 4. Provenance

Extend what the Polish app already does. Alongside `codebook.csv`, ship
`sources.csv`: office, table id, native-language name, definition, periodicity,
known breaks, licence, retrieved_at, deep link. Per-indicator "source card" in
the UI with the comparability badge. The series-break work is the template —
flags travel with the data instead of being stripped at the door.

## Sequencing

1. ~~Geography spine~~ **done**
2. ~~PxWeb adapter~~ **done**
3. Ingest source-layer data for one country end-to-end; publish it as-is
   (browsing a country's own data is already useful and ships fast)
4. Curate ~10-20 concepts with comparability tiers
5. Cross-country UI: country selector, compare view, source cards

## Known risks
- **Definitional drift** — the registered-vs-LFS trap above.
- **LAU coverage varies** by country and by variable.
- **Language** — not every office provides English labels.
- **Crosswalk rot** — this is maintenance, not a one-time build.
- **Scale** — Poland alone is 1.26B rows; multi-country may reach 10B. Parquet
  copes, but cross-country queries may outgrow the browser-only model.
