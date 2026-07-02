#!/usr/bin/env python3
"""Convert data/backbone.csv into chunked SQL seed files for the companies
table (migration 009), then print the wrangler commands to apply them.

Full-rebuild semantics: the first file truncates companies. Enrichment
columns (tech_stack, business_model, revenue, funding) are filled by later
pipeline steps; this loads the backbone fields only.

name_norm is a faithful port of kbNormCompany in src/index.js — the Worker
looks companies up by it, so the two MUST stay in sync.
"""
import csv, json, re, sys, time, unicodedata
from pathlib import Path

DATA = Path(__file__).parent / "data"
OUT = DATA / "sql"
ROWS_PER_INSERT = 50
INSERTS_PER_FILE = 100


def kb_norm_company(raw: str) -> str:
    n = unicodedata.normalize("NFD", (raw or "").lower())
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = re.sub(r"[\U0001F000-\U0001FAFF←-➿️]", " ", n)
    n = re.sub(r"[(){}\[\]«»\"“”'’#*_,;:!?.]", " ", n)
    n = re.sub(r"\b(sasu|sas|sarl|eurl|spa|gmbh|ltd|llc|inc|plc|bv|ag|srl|sa)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def sq(v) -> str:
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def num(v):
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return "NULL"


def main():
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("companies_seed_*.sql"):
        old.unlink()
    now = int(time.time() * 1000)
    rows = []
    with open(DATA / "backbone.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name = (r.get("name") or "").strip()
            if not name:
                continue
            sources = json.dumps([s.strip() for s in (r.get("source") or "").split("+") if s.strip()])
            name_norm = kb_norm_company(name) or name.lower()
            rows.append("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%d)" % (
                sq(name), sq(name_norm), sq(r.get("domain")),
                sq(r.get("linkedin_url")), sq(r.get("hq_country")), sq(r.get("hq_city")),
                sq(r.get("region")), sq(r.get("industry")),
                num(r.get("employees_min")), num(r.get("employees_max")),
                num(r.get("founded_year")), sq(sources), now,
            ))

    header = ("INSERT INTO companies (name,name_norm,domain,linkedin_url,hq_country,hq_city,"
              "region,industry,employees_min,employees_max,founded_year,sources,updated_at) VALUES\n")
    inserts = [header + ",\n".join(rows[i:i + ROWS_PER_INSERT]) + ";"
               for i in range(0, len(rows), ROWS_PER_INSERT)]
    files = []
    for fi in range(0, len(inserts), INSERTS_PER_FILE):
        p = OUT / f"companies_seed_{fi // INSERTS_PER_FILE:02d}.sql"
        body = "\n".join(inserts[fi:fi + INSERTS_PER_FILE]) + "\n"
        if fi == 0:
            body = "DELETE FROM companies;\n" + body
        p.write_text(body, encoding="utf-8")
        files.append(p)
    print(f"{len(rows)} companies -> {len(files)} files in {OUT}")
    for p in files:
        print(f"  WRANGLER_HOME=~/.wrangler npx wrangler d1 execute sourcing-scorer --remote --file {p} -y")


if __name__ == "__main__":
    sys.exit(main())
