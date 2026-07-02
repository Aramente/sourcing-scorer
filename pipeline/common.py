"""Shared helpers for the sourcing-scorer company backbone pipeline."""
import csv
import json
import os
import re
import sys

PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PIPELINE_DIR, "data")

# ---------------------------------------------------------------- seeds paths
CYBERSEC_CSV = os.path.expanduser(
    "~/Downloads/Market Mapping GitGuardian - USA Cybersec companies.csv"
)
FR_SCALEUPS_CSV = os.path.expanduser(
    "~/Claude/Projects/Sourcing-Scorer/data/target_companies.csv"
)
US_LOOKALIKES_JSON = os.path.join(DATA_DIR, "us_lookalikes.json")

# ------------------------------------------------------------------- geo maps
EU_COUNTRIES = {
    "united kingdom", "germany", "netherlands", "spain", "ireland", "belgium",
    "sweden", "denmark", "norway", "finland", "iceland", "switzerland",
    "austria", "italy", "portugal", "poland", "luxembourg", "czechia",
    "czech republic", "estonia", "latvia", "lithuania", "romania", "hungary",
    "bulgaria", "croatia", "slovakia", "slovenia", "greece", "malta", "cyprus",
}


def region_for_country(country: str):
    c = (country or "").strip().lower()
    if c == "france":
        return "fr"
    if c == "united states":
        return "us"
    if c in EU_COUNTRIES:
        return "eu"
    return None


# ---------------------------------------------------------------- industries
TECH_INDUSTRIES = {
    "computer software",
    "information technology and services",
    "internet",
    "computer & network security",
    "computer networking",
    "semiconductors",
    "telecommunications",
}

# ------------------------------------------------------------------ size map
def normalize_size(size: str) -> str:
    """PDL writes '51 - 200'; normalize to '51-200'."""
    return (size or "").replace(" ", "").strip()


SIZE_RANGES = {
    "1-10": (1, 10),
    "11-50": (11, 50),
    "51-200": (51, 200),
    "201-500": (201, 500),
    "501-1000": (501, 1000),
    "1001-5000": (1001, 5000),
    "5001-10000": (5001, 10000),
    "10001+": (10001, None),
}
# Backbone keeps 11-50 .. 5001-10000 (drops 1-10 shells and 10001+ megacorps).
BACKBONE_SIZES = {
    "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000",
}

# --------------------------------------------------------- name normalization
_SUFFIXES = (
    r"inc|incorporated|corp|corporation|co|company|ltd|limited|llc|llp|plc|"
    r"sas|sa|sarl|sasu|gmbh|ag|bv|b\.v|nv|ab|as|oy|aps|srl|spa|kk|group|holdings"
)
_SUFFIX_RE = re.compile(r"\b(?:%s)\b\.?$" % _SUFFIXES)
_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")


def normalize_name(name: str) -> str:
    """Lowercase, strip punctuation and trailing corporate suffixes."""
    n = (name or "").lower().strip()
    n = _NON_ALNUM.sub(" ", n)
    n = re.sub(r"\s+", " ", n).strip()
    prev = None
    while n != prev:  # strip stacked suffixes ("acme co inc")
        prev = n
        n = _SUFFIX_RE.sub("", n).strip()
    return n


def normalize_domain(domain: str) -> str:
    d = (domain or "").strip().lower()
    d = re.sub(r"^https?://", "", d)
    d = re.sub(r"^www\.", "", d)
    return d.split("/")[0].strip()


def normalize_linkedin(url: str) -> str:
    u = (url or "").strip().lower()
    if not u:
        return ""
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = u.rstrip("/")
    if u and not u.startswith("linkedin.com"):
        u = "linkedin.com/company/" + u.split("/")[-1]
    return "https://www." + u if u else ""


def parse_locality_city(locality: str) -> str:
    """PDL locality looks like 'san francisco, california, united states'."""
    loc = (locality or "").strip()
    return loc.split(",")[0].strip().title() if loc else ""


# ---------------------------------------------------------------- seed loading
def load_seed_cybersec():
    """~966 US cybersec companies (Crunchbase export). Header is on line 6."""
    rows = []
    with open(CYBERSEC_CSV, newline="", encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    # find the real header row
    start = next(i for i, l in enumerate(lines) if l.startswith("Company,"))
    reader = csv.DictReader(lines[start:])
    for r in reader:
        name = (r.get("Company") or "").strip()
        if not name:
            continue
        hq = (r.get("Headquarters Location") or "").strip()
        city = hq.split(",")[0].strip() if hq else ""
        emp = (r.get("N° of Employees") or "").strip()
        emin = emax = ""
        m = re.match(r"^(\d+)\s*-\s*(\d+)$", emp)
        if m:
            emin, emax = m.group(1), m.group(2)
        elif emp.endswith("+") and emp[:-1].isdigit():
            emin = emp[:-1]
        rows.append({
            "name": name,
            "domain": "",
            "linkedin_url": "",
            "hq_country": "united states",
            "hq_city": city,
            "region": "us",
            "industry": (r.get("Industries") or "").strip(),
            "employees_min": emin,
            "employees_max": emax,
            "founded_year": "",
            "source": "seed_us_cybersec",
        })
    return rows


def load_seed_fr_scaleups():
    """~416 FR scale-ups from target_companies.csv (has domain + founded_year)."""
    rows = []
    with open(FR_SCALEUPS_CSV, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            name = (r.get("name") or "").strip()
            if not name:
                continue
            fy = (r.get("founded_year") or "").strip()
            rows.append({
                "name": name,
                "domain": normalize_domain(r.get("domain") or ""),
                "linkedin_url": "",
                "hq_country": "france",
                "hq_city": "",
                "region": "fr",
                "industry": (r.get("sector") or "").strip(),
                "employees_min": "",
                "employees_max": "",
                "founded_year": fy if fy.isdigit() else "",
                "source": "seed_fr_scaleups",
            })
    return rows


def load_seed_us_lookalikes():
    """5,941 US lookalike companies dumped from the deployed D1."""
    with open(US_LOOKALIKES_JSON, encoding="utf-8") as f:
        data = json.load(f)
    results = data[0]["results"] if isinstance(data, list) else data["results"]
    rows = []
    for r in results:
        name = (r.get("name") or "").strip()
        if not name:
            continue
        rows.append({
            "name": name,
            "domain": "",
            "linkedin_url": "",
            "hq_country": "united states",
            "hq_city": (r.get("city") or "").strip(),
            "region": "us",
            "industry": (r.get("category") or "").strip(),
            "employees_min": "",
            "employees_max": "",
            "founded_year": "",
            "source": "us_lookalike",
        })
    return rows


def all_seed_rows():
    return load_seed_fr_scaleups() + load_seed_cybersec() + load_seed_us_lookalikes()


def find_pdl_csv():
    """Locate companies_sorted.csv under data/kagglehub (any version)."""
    base = os.path.join(DATA_DIR, "kagglehub")
    for root, _dirs, files in os.walk(base):
        if "companies_sorted.csv" in files:
            return os.path.join(root, "companies_sorted.csv")
    sys.exit("companies_sorted.csv not found under %s — run 01_download_pdl.sh" % base)


BACKBONE_COLUMNS = [
    "name", "domain", "linkedin_url", "hq_country", "hq_city", "region",
    "industry", "employees_min", "employees_max", "founded_year", "source",
]
