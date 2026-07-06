#!/usr/bin/env node
/* Batch business_model classification (spec step 8): pulls companies missing
 * business_model from remote D1, classifies via /api/companies/classify-batch
 * (Anthropic if ANTHROPIC_API_KEY is set on the target, else Workers AI), and
 * writes chunked UPDATE SQL files to data/sql/business_model_*.sql.
 *
 * The classify endpoint is stateless (see src/index.js classifyBusinessModel) —
 * this script owns persistence so it can run against a `wrangler dev` instance
 * (local D1, real AI binding) without needing production login credentials.
 * Apply the generated files with `wrangler d1 execute --remote --file`.
 *
 * Usage: node 08_business_model.js <endpoint-base-url> <session-cookie>
 *   e.g. node 08_business_model.js http://localhost:8788 ss_session=<token>
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.argv[2] || 'http://localhost:8788';
const COOKIE = process.argv[3];
if (!COOKIE) { console.error('Usage: node 08_business_model.js <base-url> <cookie>'); process.exit(1); }

const DATA = path.join(__dirname, 'data');
const OUT = path.join(DATA, 'sql');
const BATCH = 60;
const CONCURRENCY = 6;

function sq(v) { return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }

async function fetchRows(limit) {
  const limitSql = Number.isInteger(limit) ? ` LIMIT ${limit}` : '';
  const raw = execSync(
    `WRANGLER_HOME=~/.wrangler npx wrangler d1 execute sourcing-scorer --remote --json ` +
    `--command "SELECT id,name,industry FROM companies WHERE business_model IS NULL${limitSql}"`,
    { cwd: path.join(__dirname, '..'), maxBuffer: 1024 * 1024 * 200 }
  ).toString();
  const parsed = JSON.parse(raw);
  return parsed[0].results;
}

async function classifyBatch(items) {
  const res = await fetch(`${BASE}/api/companies/classify-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
    body: JSON.stringify({ items: items.map(c => ({ name: c.name, industry: c.industry })) }),
  });
  if (!res.ok) throw new Error(`classify-batch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { results } = await res.json();
  return results;
}

async function main() {
  const limitArg = process.argv[4] ? parseInt(process.argv[4]) : undefined;
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Fetching companies missing business_model from remote D1...');
  const rows = await fetchRows(limitArg);
  console.log(`${rows.length} companies to classify`);

  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));

  const updates = [];
  let done = 0, failed = 0;
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const idx = next++;
      const chunk = chunks[idx];
      try {
        const results = await classifyBatch(chunk);
        for (const r of results) {
          const row = chunk[r.i];
          if (row) updates.push({ id: row.id, business_model: r.business_model });
        }
        done += chunk.length;
      } catch (e) {
        failed += chunk.length;
        console.error(`batch ${idx} failed: ${e.message}`);
      }
      if (idx % 20 === 0) console.log(`progress: ${done + failed}/${rows.length} (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`classified ${updates.length}/${rows.length} (${failed} failed, retry by re-running — WHERE business_model IS NULL only picks up misses)`);

  const now = Date.now();
  const PER_FILE = 500;
  for (let f = 0; f < updates.length; f += PER_FILE) {
    const stmts = updates.slice(f, f + PER_FILE)
      .map(u => `UPDATE companies SET business_model=${sq(u.business_model)}, updated_at=${now} WHERE id=${u.id};`);
    fs.writeFileSync(path.join(OUT, `business_model_${String(f / PER_FILE).padStart(2, '0')}.sql`), stmts.join('\n') + '\n');
  }
  console.log(`wrote ${Math.ceil(updates.length / PER_FILE)} SQL files to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
