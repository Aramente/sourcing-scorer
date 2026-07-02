#!/usr/bin/env python3
"""02_filter_backbone.py — single streaming pass over the PDL 7M company dataset.

Produces two files in data/:
  pdl_filtered.csv     candidate backbone rows: target countries (FR/EU/US),
                       tech industries, linkedin url present, size 11-10000.
  pdl_seed_matches.csv every PDL row whose normalized name OR domain matches a
                       seed company (any industry/size), used by 03 to gap-fill
                       seed rows with linkedin_url/domain/etc.

Re-runnable; takes ~2-4 min over 7.17M rows. Usage: python3 02_filter_backbone.py
"""
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    DATA_DIR, TECH_INDUSTRIES, BACKBONE_SIZES, SIZE_RANGES, normalize_size,
    region_for_country, normalize_name, normalize_domain,
    all_seed_rows, find_pdl_csv,
)

PDL_COLS = ["name", "domain", "year founded", "industry", "size range",
            "locality", "country", "linkedin url",
            "current employee estimate", "total employee estimate"]

OUT_FILTERED = os.path.join(DATA_DIR, "pdl_filtered.csv")
OUT_SEED_MATCHES = os.path.join(DATA_DIR, "pdl_seed_matches.csv")


def main():
    pdl_csv = find_pdl_csv()
    print("Reading", pdl_csv)

    seeds = all_seed_rows()
    seed_names = {normalize_name(s["name"]) for s in seeds if s["name"]}
    seed_names.discard("")
    seed_domains = {s["domain"] for s in seeds if s["domain"]}
    print(f"{len(seeds)} seed rows -> {len(seed_names)} names, "
          f"{len(seed_domains)} domains to match")

    n_total = n_filtered = n_seed_match = 0
    csv.field_size_limit(10 ** 7)

    with open(pdl_csv, newline="", encoding="utf-8") as fin, \
         open(OUT_FILTERED, "w", newline="", encoding="utf-8") as ffil, \
         open(OUT_SEED_MATCHES, "w", newline="", encoding="utf-8") as fseed:
        reader = csv.DictReader(fin)
        out_cols = PDL_COLS + ["region", "norm_name"]
        w_fil = csv.DictWriter(ffil, fieldnames=out_cols, extrasaction="ignore")
        w_seed = csv.DictWriter(fseed, fieldnames=out_cols, extrasaction="ignore")
        w_fil.writeheader()
        w_seed.writeheader()

        for row in reader:
            n_total += 1
            if n_total % 1_000_000 == 0:
                print(f"  ...{n_total:,} rows scanned")

            country = (row.get("country") or "").strip().lower()
            region = region_for_country(country)
            linkedin = (row.get("linkedin url") or "").strip()
            domain = normalize_domain(row.get("domain") or "")
            norm = normalize_name(row.get("name") or "")

            # seed matching: any industry/size, but must bring something useful
            if (linkedin or domain) and (
                (norm and norm in seed_names) or (domain and domain in seed_domains)
            ):
                row["region"] = region or ""
                row["norm_name"] = norm
                w_seed.writerow(row)
                n_seed_match += 1

            # backbone candidates
            if not region:
                continue
            if (row.get("industry") or "").strip().lower() not in TECH_INDUSTRIES:
                continue
            if not linkedin:
                continue
            if normalize_size(row.get("size range")) not in BACKBONE_SIZES:
                continue
            row["region"] = region
            row["norm_name"] = norm
            w_fil.writerow(row)
            n_filtered += 1

    print(f"Scanned {n_total:,} PDL rows")
    print(f"  -> {n_filtered:,} backbone candidates in {OUT_FILTERED}")
    print(f"  -> {n_seed_match:,} seed-name/domain matches in {OUT_SEED_MATCHES}")


if __name__ == "__main__":
    main()
