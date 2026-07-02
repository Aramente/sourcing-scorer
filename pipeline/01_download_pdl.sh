#!/usr/bin/env bash
# 01_download_pdl.sh — download the People Data Labs "Free 7+ Million Company Dataset"
# License: CC BY 4.0 (https://www.kaggle.com/datasets/peopledatalabssf/free-7-million-company-dataset)
# Downloads anonymously via kagglehub (no Kaggle account needed for public datasets).
# Result: data/kagglehub/datasets/peopledatalabssf/free-7-million-company-dataset/versions/<n>/companies_sorted.csv (~1.1 GB)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet kagglehub

mkdir -p data
KAGGLEHUB_CACHE="$(pwd)/data/kagglehub" .venv/bin/python - <<'EOF'
import kagglehub
path = kagglehub.dataset_download("peopledatalabssf/free-7-million-company-dataset")
print("Downloaded to:", path)
EOF
