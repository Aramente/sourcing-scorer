#!/usr/bin/env python3
"""03_merge_seeds.py — merge seed lists with PDL backbone candidates.

Inputs (produced by earlier steps):
  data/pdl_filtered.csv      backbone candidates from 02
  data/pdl_seed_matches.csv  PDL rows matching seed names/domains from 02
  seed files                 (see common.py: FR scale-ups, US cybersec, US lookalikes)

Output:
  data/backbone.csv  columns: name, domain, linkedin_url, hq_country, hq_city,
                     region (fr|eu|us), industry, employees_min, employees_max,
                     founded_year, source

Rules:
  - Seeds ALWAYS survive (they are the priority rows), gap-filled from PDL.
  - Dedupe by domain first, then by normalized name.
  - Regional quotas (seeds count toward them): FR ~6500, EU ~5500, US ~7000.
  - PDL fill rows ranked: founded >= 2005 first, then older-known, then
    unknown-founded; within a group, larger current-employee estimate first.

Usage: python3 03_merge_seeds.py
"""
import csv
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    DATA_DIR, BACKBONE_COLUMNS, SIZE_RANGES, normalize_size,
    normalize_name, normalize_domain, normalize_linkedin, parse_locality_city,
    load_seed_fr_scaleups, load_seed_cybersec, load_seed_us_lookalikes,
)

IN_FILTERED = os.path.join(DATA_DIR, "pdl_filtered.csv")
IN_SEED_MATCHES = os.path.join(DATA_DIR, "pdl_seed_matches.csv")
OUT_BACKBONE = os.path.join(DATA_DIR, "backbone.csv")

QUOTAS = {"fr": 6500, "eu": 5500, "us": 7000}


def parse_year(v):
    v = (v or "").strip()
    try:
        return str(int(float(v)))
    except ValueError:
        return ""


def pdl_row_score(r):
    """Lower is better."""
    fy = parse_year(r.get("year founded"))
    if fy and int(fy) >= 2005:
        group = 0
    elif fy:
        group = 1
    else:
        group = 2
    try:
        emp = int(r.get("current employee estimate") or 0)
    except ValueError:
        emp = 0
    return (group, -emp)


def load_seed_match_index():
    """Index PDL seed-match rows by normalized name and by domain."""
    by_name = defaultdict(list)
    by_domain = defaultdict(list)
    if not os.path.exists(IN_SEED_MATCHES):
        sys.exit("%s missing — run 02_filter_backbone.py first" % IN_SEED_MATCHES)
    with open(IN_SEED_MATCHES, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("norm_name"):
                by_name[r["norm_name"]].append(r)
            d = normalize_domain(r.get("domain") or "")
            if d:
                by_domain[d].append(r)
    return by_name, by_domain


def best_match(candidates, want_country):
    """Pick the best PDL match: right country > has linkedin > bigger employer."""
    def key(r):
        country_ok = 0 if (r.get("country") or "").strip().lower() == want_country else 1
        has_li = 0 if (r.get("linkedin url") or "").strip() else 1
        try:
            emp = int(r.get("current employee estimate") or 0)
        except ValueError:
            emp = 0
        return (country_ok, has_li, -emp)
    return sorted(candidates, key=key)[0] if candidates else None


def gap_fill(seed, m):
    """Fill empty seed fields from a PDL match row."""
    if not m:
        return False
    if not seed["linkedin_url"]:
        seed["linkedin_url"] = normalize_linkedin(m.get("linkedin url") or "")
    if not seed["domain"]:
        seed["domain"] = normalize_domain(m.get("domain") or "")
    if not seed["hq_city"]:
        seed["hq_city"] = parse_locality_city(m.get("locality") or "")
    if not seed["founded_year"]:
        seed["founded_year"] = parse_year(m.get("year founded"))
    if not seed["industry"]:
        seed["industry"] = (m.get("industry") or "").strip()
    if not seed["employees_min"]:
        rng = SIZE_RANGES.get(normalize_size(m.get("size range")))
        if rng:
            seed["employees_min"] = str(rng[0])
            seed["employees_max"] = "" if rng[1] is None else str(rng[1])
    return True


def main():
    by_name, by_domain = load_seed_match_index()

    # ---- 1. seeds, in priority order --------------------------------------
    seed_groups = [
        ("seed_fr_scaleups", load_seed_fr_scaleups(), "france"),
        ("seed_us_cybersec", load_seed_cybersec(), "united states"),
        ("us_lookalike", load_seed_us_lookalikes(), "united states"),
    ]

    merged = []               # final row dicts
    idx_by_domain = {}        # domain -> row
    idx_by_name = {}          # norm name -> row
    match_stats = {}

    for tag, rows, want_country in seed_groups:
        matched = 0
        for s in rows:
            norm = normalize_name(s["name"])
            cands = list(by_name.get(norm, []))
            if s["domain"]:
                cands += by_domain.get(s["domain"], [])
            if gap_fill(s, best_match(cands, want_country)):
                matched += 1

            # dedupe among seeds: domain first, then normalized name
            existing = None
            if s["domain"] and s["domain"] in idx_by_domain:
                existing = idx_by_domain[s["domain"]]
            elif norm and norm in idx_by_name:
                existing = idx_by_name[norm]
            if existing is not None:
                if tag not in existing["source"].split("+"):
                    existing["source"] += "+" + tag
                for k in BACKBONE_COLUMNS:  # fill gaps from the duplicate
                    if not existing[k] and s.get(k):
                        existing[k] = s[k]
                continue
            merged.append(s)
            if s["domain"]:
                idx_by_domain[s["domain"]] = s
            if norm:
                idx_by_name[norm] = s
        match_stats[tag] = (matched, len(rows))

    n_seeds = len(merged)

    # ---- 2. PDL backbone fill, per-region quotas ---------------------------
    region_counts = defaultdict(int)
    for r in merged:
        region_counts[r["region"]] += 1

    pdl_by_region = defaultdict(list)
    with open(IN_FILTERED, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            pdl_by_region[r["region"]].append(r)

    for region, rows in pdl_by_region.items():
        rows.sort(key=pdl_row_score)
        budget = QUOTAS[region] - region_counts[region]
        added = 0
        for r in rows:
            if added >= budget:
                break
            domain = normalize_domain(r.get("domain") or "")
            norm = r.get("norm_name") or normalize_name(r.get("name") or "")
            if (domain and domain in idx_by_domain) or (norm and norm in idx_by_name):
                continue  # duplicate of a seed or an earlier PDL row
            rng = SIZE_RANGES.get(normalize_size(r.get("size range")), ("", ""))
            row = {
                "name": (r.get("name") or "").strip().title(),
                "domain": domain,
                "linkedin_url": normalize_linkedin(r.get("linkedin url") or ""),
                "hq_country": (r.get("country") or "").strip().lower(),
                "hq_city": parse_locality_city(r.get("locality") or ""),
                "region": region,
                "industry": (r.get("industry") or "").strip(),
                "employees_min": str(rng[0]) if rng[0] else "",
                "employees_max": "" if rng[1] in (None, "") else str(rng[1]),
                "founded_year": parse_year(r.get("year founded")),
                "source": "pdl",
            }
            merged.append(row)
            if domain:
                idx_by_domain[domain] = row
            if norm:
                idx_by_name[norm] = row
            region_counts[region] += 1
            added += 1

    # ---- 3. write + stats ---------------------------------------------------
    with open(OUT_BACKBONE, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=BACKBONE_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(merged)

    total = len(merged)
    with_li = sum(1 for r in merged if r["linkedin_url"])
    with_emp = sum(1 for r in merged if r["employees_min"])
    with_dom = sum(1 for r in merged if r["domain"])
    print(f"Wrote {total:,} rows to {OUT_BACKBONE}")
    print(f"  seeds: {n_seeds:,} (always kept)   pdl fill: {total - n_seeds:,}")
    for region in ("fr", "eu", "us"):
        print(f"  region {region}: {region_counts[region]:,}")
    print(f"  with linkedin_url: {with_li:,} ({100*with_li/total:.1f}%)")
    print(f"  with domain:       {with_dom:,} ({100*with_dom/total:.1f}%)")
    print(f"  with employee rng: {with_emp:,} ({100*with_emp/total:.1f}%)")
    for tag, (m, n) in match_stats.items():
        print(f"  seed match rate {tag}: {m}/{n} ({100*m/n:.1f}%)")


if __name__ == "__main__":
    main()
