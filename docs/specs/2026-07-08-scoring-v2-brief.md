# Scoring v2: embeddings, outcome tracking, active learning — brief for next session

## Why this exists

Kevin runs multiple candidate lists/jobs over time (not a one-off "rank this
list once" workflow) and asked directly: is a custom-built scoring tool even
worth it over just pasting a candidate list to Claude and asking for a top
200? The honest answer: only if the tool remembers across imports and
actually gets smarter the more it's used — which today it barely does. This
brief is the concrete plan to make that true. It followed a research pass
into real open source ATS/resume-matching/recommender projects for specific,
named techniques (not vague inspiration) — see References at the bottom.

Not yet approved for a full build — the next session should confirm scope
and cost with Kevin before starting, especially Vectorize (a new Cloudflare
product to provision). Kevin's own suggestion when this was floated: start
with #1 (embeddings + cross-list similarity) as its own focused build.

## Current state (as of 2026-07-08, read the actual code before trusting this — it's a summary, not a spec)

Single-file app: `src/index.js` (Worker/API), `public/index.html` (SPA).

- **Scoring pipeline**: candidate title → LLM-classified into a facet
  taxonomy (family/seniority/setting) via `/api/classify`, cached forever in
  `title_facets`/`company_facts` (D1). Classifier is Claude
  (`ANTHROPIC_API_KEY`, not currently set) or Workers AI/Llama fallback
  (`env.AI`, currently hitting the free-tier 10k neuron/day cap under real
  load). Score = keyword/facet match (`scoreWithFacets`/`scoreMatch` in
  `public/index.html`) + company bonuses.
- **Company bonuses** (all additive, in `adjustedScore()`):
  `companyReputation` (per-job keep/skip ratio for that company, cached),
  `companyPreferenceBonus`/`companyFilterOrPreferenceBonus` (curated
  `preferred_companies` tier list, flat +10/+15, OR a per-job "Must
  have"/"Prefer" company-DB filter set — see
  `docs/specs/2026-07-02-company-db-reframe.md`), `learnedAdjustment` (simple
  log-odds/Bayesian smoothing over keep-vs-exclude counts bucketed by
  `(family, seniority, setting)`, shared across jobs in the same family, in
  `facet_weights` table).
- **Companies DB**: ~19k rows (`companies` table) — name, domain, region,
  industry, business_model, employee range, funding. Built by an offline
  Python pipeline (`pipeline/`), not the Worker, except a new opt-in
  "enrich new companies via Claude Sonnet" path added 2026-07-08
  (`/api/companies/enrich`, needs `ANTHROPIC_API_KEY`).
- **Decisions**: flat `decisions` table (`user_id, candidate_key, action`),
  action is one of `kept`/`excl`/`view` only. No outcome beyond that — a
  "kept" candidate that never got contacted, or got contacted and ghosted,
  looks identical to one who got hired.
- **No semantic matching at all.** Everything is keyword/facet-bucket based.
  No embeddings, no vector search, no resume/profile text beyond
  name+title+company+LinkedIn URL.
- **No cross-list intelligence.** Each job's candidate pool is scored
  independently; there's no "find people like this one, anywhere I've ever
  imported" — which is exactly what Kevin needs given he runs multiple lists.

## The gap

1. No semantic understanding — matching is entirely keyword/bucket, so two
   candidates with differently-worded but equivalent titles/backgrounds
   aren't recognized as similar, and there's no cross-list "more like this"
   capability at all.
2. The only learning signal is keep/skip/viewed at first glance — there's no
   way to learn what actually leads to a reply or a hire, so the system can
   only ever get as good as Kevin's gut reaction, never better.
3. `learnedAdjustment` is a static bucketed log-odds formula, not a real
   ranker — it can't use embedding similarity, company tier, and facets
   together as combined features.
4. Triage order is always highest-score-first, which is the least
   informative order for actually improving the model (see active learning
   below).

## Recommended build order

### 1. Semantic embeddings via Cloudflare Vectorize (highest leverage, start here)

Embed each candidate (title + company + any headline text available) using
a Workers AI embedding model (`@cf/baai/bge-base-en-v1.5`, 768-dim), store in
a Vectorize index. This unlocks two things at once:

- **Cross-list similarity search**: given one kept candidate, `query()` the
  index to surface similar candidates from *every* list Kevin has ever
  imported, not just the current job. Directly answers his stated need.
- **Retrieve-then-rerank scoring**: embed the job's own title/description,
  retrieve the top-N candidates by cosine similarity, then re-rank that
  shortlist with the existing Claude-based classifier instead of (or in
  addition to) pure keyword facet matching. This is the actual state of the
  art pattern in real open-source resume-matchers (see References).

Feasibility: fully native to the existing stack — Workers AI already has an
embedding model available, Vectorize is a Cloudflare product (needs
provisioning + a `[[vectorize]]` binding in `wrangler.toml`; confirm current
pricing/limits with Kevin before committing, since this is a new line item).

### 2. Real outcome tracking beyond keep/skip

Add pipeline stages past "kept" — e.g. contacted → replied → interviewing →
hired (standard in every open-source ATS, e.g. OpenCATS). This is the
missing feedback loop: without it, nothing can ever learn what actually
works, only what Kevin's first-glance instinct was. Needs:
- A new D1 table or an extended `decisions.action` enum/second column for
  stage-beyond-kept.
- Minimal UI: a few buttons/states on an already-kept candidate card, not a
  full CRM rebuild.
- This is also the prerequisite for #4 (a real ranker needs real labels).

### 3. Uncertainty-based triage ordering (cheap, high value)

Active-learning "margin sampling": instead of always sorting highest-score-
first, offer a "most informative next" mode that surfaces candidates whose
adjusted score sits closest to the HOT/WARM decision boundary, or whose
facet bucket has the least decision history yet. Each such click teaches the
learned-adjustment/ranker more per decision than clicking on an obvious HOT
candidate does. Trivial to implement: an alternate sort key
(`abs(adjustedScore(c) - threshold)` ascending) behind a new tier-filter
option, reusing the tier-filter UI pattern already built 2026-07-07
(`tierFilter` in `public/index.html`).

### 4. A real online-learning ranker, replacing the static log-odds bucket

Once #1 (embedding similarity as a feature) and #2 (real outcome labels)
exist, replace `learnedAdjustment`'s bucketed log-odds with a small
logistic-regression-style ranker over features: facet bucket, company tier,
embedding similarity to job, region/industry match. Updated incrementally
after every decision (no training job, no batch — just a weight nudge per
label, entirely doable in JS, no Python/heavy ML runtime needed). This is
the actual "smarter algorithm" Kevin asked about, not just more bonuses
stacked additively.

## Explicit non-recommendations

- **Don't** reach for a Python ML runtime, FAISS, or LightFM directly — none
  run in Cloudflare Workers. Vectorize + a hand-rolled linear ranker in TS
  cover the same ground without a runtime change.
- **Don't** rebuild this as a full ATS/CRM (Argilla, Label Studio, OpenCATS
  itself are worth a look purely for UX inspiration on decision-capture, not
  as something to adopt wholesale — they're standalone heavy apps).
- The existing curated-tier + per-job-reputation + Bayesian adjustment is
  already a reasonable simplified hybrid recommender; the two things
  missing to make "improves over time" actually true are embeddings (#1)
  and real outcome labels (#2) — not a wholesale rewrite.

## Open decisions for the next session to confirm with Kevin first

- Vectorize cost/provisioning — is he okay adding this Cloudflare product?
- Scope of outcome-stage UI — how many stages does he actually want to
  track, and does he want it enforced (must go through stages in order) or
  freeform?
- Whether embeddings should include more than title+company (e.g. paste in
  a LinkedIn "About" section) if the scraper can capture it — richer text
  gives much better embedding quality but needs a scraper change, which is
  a separate project (`LinkedIn Scraper service`, not in this repo).
- Confirm current `ANTHROPIC_API_KEY` status — several 2026-07-08 features
  (company enrichment, and any Claude-based rerank step in #1) depend on it
  being configured; it was not set as of this writing.

## References (from 2026-07-08 research pass — verify these are still current before citing to Kevin)

- Two-stage embed-then-rerank pattern: [vectornguyen76/resume-ranking](https://github.com/vectornguyen76/resume-ranking), [ConFit](https://arxiv.org/pdf/2502.12361)
- Active learning / uncertainty sampling: [modAL](https://github.com/modAL-python/modAL), [Label Sleuth](https://www.label-sleuth.org/)
- ATS pipeline-stage inspiration: [OpenCATS](https://github.com/opencats/OpenCATS), [Horilla](https://www.horilla.com/), [Reqcore](https://reqcore.com/)
- Implicit-feedback ranking philosophy (not runnable in Workers, steal the
  ideas not the library): [LightFM](https://github.com/lyst/lightfm)
- Cloudflare Vectorize + Workers AI embeddings setup: [developers.cloudflare.com/vectorize/get-started/embeddings](https://developers.cloudflare.com/vectorize/get-started/embeddings/)
