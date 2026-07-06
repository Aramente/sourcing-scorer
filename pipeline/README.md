# Company backbone pipeline

Builds `data/backbone.csv` — a 10-20K row database of tech/software companies in
France, Europe and the US, keyed on LinkedIn URL, for the sourcing-scorer app.

Columns: `name, domain, linkedin_url, hq_country, hq_city, region (fr|eu|us),
industry, employees_min, employees_max, founded_year, source`

## Data sources

| Source | What | License / access |
|---|---|---|
| People Data Labs "Free 7+ Million Company Dataset" | backbone rows + gap-fill for seeds | **CC BY 4.0**, downloaded anonymously from Kaggle (`peopledatalabssf/free-7-million-company-dataset`) via `kagglehub` — no account needed |
| `~/Downloads/Market Mapping GitGuardian - USA Cybersec companies.csv` | 966 US cybersec companies (Crunchbase export, header on line 6) | internal seed |
| `~/Claude/Projects/Sourcing-Scorer/data/target_companies.csv` | 416 FR scale-ups | internal seed |
| `data/us_lookalikes.json` | 5,941 US lookalike companies dumped from the deployed D1 | internal seed |

Attribution note: rows with `source=pdl` (and PDL gap-filled fields on seed rows)
come from the People Data Labs free company dataset (CC BY 4.0 — attribution
required if redistributed).

## Steps

```bash
# 0. refresh the D1 lookalike dump (only when the D1 table changes)
cd ~/Desktop/Gitguardian/sourcing-scorer
WRANGLER_HOME=~/.wrangler npx wrangler d1 execute sourcing-scorer --remote \
  --command "SELECT city,name,tier,category FROM us_lookalike_companies" \
  -y --json > pipeline/data/us_lookalikes.json

cd pipeline
./01_download_pdl.sh        # ~280 MB download, extracts ~1.1 GB CSV into data/kagglehub/
python3 02_filter_backbone.py   # streams the 7.17M rows (~2 min), writes:
                                #   data/pdl_filtered.csv     (backbone candidates)
                                #   data/pdl_seed_matches.csv (rows matching seed names/domains)
python3 03_merge_seeds.py       # merges + dedupes, writes data/backbone.csv and prints stats
```

Everything is re-runnable and idempotent; only stdlib Python is needed for
02/03 (01 creates `.venv` for `kagglehub`).

## Filtering rules (02)

- country in FR / EU (UK, DACH, Benelux, Nordics, ES, IT, PT, IE, PL, Baltics,
  CEE...) / US
- industry in: computer software, information technology and services, internet,
  computer & network security, computer networking, semiconductors,
  telecommunications
- LinkedIn URL required
- size range 11-50 through 5001-10000 (drops 1-10 shells and 10001+ megacorps;
  seed companies are exempt from all these rules)

## Merge rules (03)

- Seeds ALWAYS survive dedup, and are gap-filled (linkedin_url, domain, city,
  founded_year, employee range) from PDL by domain match, then normalized-name
  match (preferring right-country, has-linkedin, larger-employer matches).
- Dedup key: normalized domain first, then normalized company name (lowercased,
  punctuation and corporate suffixes stripped). Duplicate seeds merge their
  `source` tags with `+`.
- Regional quotas (seeds count toward them): FR 6,500 / EU 5,500 / US 7,000.
- PDL fill ranking: founded >= 2005 first, then older-with-known-year, then
  unknown year; within each group, larger current-employee estimate first.

## Monthly refresh

1. Re-dump the D1 lookalikes (step 0) if that table changed.
2. `./01_download_pdl.sh` — kagglehub caches by version; delete
   `data/kagglehub/` first to force a fresh pull (PDL updates the Kaggle
   dataset rarely; the refresh mostly picks up seed changes).
3. `python3 02_filter_backbone.py && python3 03_merge_seeds.py`
4. Check the printed stats (row counts per region, % with linkedin_url, seed
   match rates) before loading `data/backbone.csv` into the app.

Unmatched seed rows (mostly `us_lookalike` names with no PDL hit) are kept with
an empty `linkedin_url` — a later gap-fill step handles them.

## Enrichment steps (after loading backbone.csv into D1 via 09_upsert_d1.py)

| Step | Script | Status |
|---|---|---|
| 04. LinkedIn gap-fill (Serper) | — | not built |
| 05. SIREN matching | — | **skipped deliberately** (see below) |
| 06. FR revenue (INPI comptes annuels) | — | **skipped deliberately** (see below) |
| 07. Tech stack (GitHub org languages) | `07_tech_stack.js` | built, validated, run against full DB |
| 08. Business model (Anthropic/Workers AI) | `08_business_model.js` | built, run against full DB (subject to Workers AI's 10k neurons/day free quota — rerun to pick up any still-`NULL` rows) |
| 09. D1 upsert | `09_upsert_d1.py` | built — loads backbone.csv into the `companies` table |

**05/06 skipped on purpose** (2026-07-06): INPI's `data.inpi.fr` comptes-annuels
API is genuinely free (just an account signup, confirmed working — auth is
`POST /api/sso/login` with the account email/password → Bearer token; revenue
is liasse code `FJ`, page 3, column `m3`) and gives real filed chiffre
d'affaires, no LLM guessing needed. But three compounding factors make it not
worth building for this target company list: SIREN resolution would need
conservative exact-name matching (real coverage maybe 60-70%), only companies
with a *digitized* (not PDF-only) bilan count, and ~45% of French companies
legally file under confidentiality — no CA public anywhere, free or paid.
Combined, realistic yield was ~25-40% of the ~6,500 FR companies — and Kevin's
own read is that the target company profile (funded scale-ups, or French subs
of foreign parents) is exactly the profile most likely to file confidentially
or have no meaningful standalone French P&L. If this changes, the technical
path is fully documented above — pick it back up without re-researching INPI.

`07_tech_stack.js` is deliberately conservative (org existing at a guessed
slug is not enough — requires the org profile's `blog` domain or `name` field
to corroborate) since a wrong GitHub org attached to the wrong company is
worse than no data. Real-world match rate on the full ~17K-company run was
~19% (see git log for the run's summary), concentrated in dev-tool/SaaS/infra
companies; near-zero for consulting/staffing/agency-type rows.

## Known caveats

- The Kaggle copy of the PDL dataset is **version 1 (2019 vintage)** — employee
  ranges and the newest startups are stale/missing. LinkedIn URLs and domains
  age well, employee counts don't; treat `employees_min/max` as approximate
  (e.g. GitGuardian itself gap-fills as 1-10). A later enrichment step (or the
  LinkedIn scraper) should refresh sizes for rows that matter.
- ~6% of rows (unmatched seeds) have no `linkedin_url` yet.
- PDL company names are lowercase; the pipeline title-cases them, so acronyms
  render like "Ibm".
