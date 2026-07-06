#!/usr/bin/env node
/* Tech stack enrichment via GitHub org language detection (spec step 7 —
 * docs/specs/2026-07-02-company-db-reframe.md explicitly wants "GitHub org
 * languages + job-board APIs", NOT website fingerprinting or LLM guessing).
 *
 * This script only implements the GitHub-org half. For each company missing
 * tech_stack, it derives 1-2 candidate GitHub org slugs (from the domain and
 * from the normalized company name), checks whether an org exists at that
 * slug via `gh api orgs/{slug}/repos`, and — only if the org's profile
 * corroborates the match (blog domain or org name lines up with the company)
 * — aggregates the primary `language` of up to 100 non-fork, non-archived
 * public repos (sorted by last push) into a top-5 tech_stack array.
 *
 * Deliberately conservative: an org existing at a plausible slug is NOT
 * enough on its own (see e.g. github.com/ArteFact, an unrelated project that
 * happens to share a slug with the "Artefact" consulting firm) — corroborate
 * via org profile `blog`/`name` or skip. A wrong org attached to the wrong
 * company is worse than no data.
 *
 * Uses the `gh` CLI (not raw fetch) so it reuses the machine's authenticated
 * token and its 5000 req/hr rate limit; paces itself against `gh api
 * rate_limit` when the full company list is run.
 *
 * Usage:
 *   node 07_tech_stack.js                 # full pass over remote D1, writes SQL files
 *   node 07_tech_stack.js --limit 500     # cap how many D1 rows are pulled
 *   node 07_tech_stack.js --dry-run       # curated known-good/known-bad sample,
 *                                         # prints results, writes no files, no D1 reads
 *
 * Apply generated files with `wrangler d1 execute --remote --file`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DATA = path.join(__dirname, 'data');
const OUT = path.join(DATA, 'sql');
const CONCURRENCY = 4;
const MIN_RATE_REMAINING = 200; // below this, sleep until the rate window resets
const RATE_CHECK_EVERY = 25; // check quota every N gh api calls
const CHECKPOINT_EVERY = 200; // flush matched rows to SQL + record checked ids this often,
                               // so a kill mid-run loses at most this many companies' API work
const SEEN_IDS_FILE = path.join(DATA, 'tech_stack_seen_ids.json');

// Slugs some companies use for their GitHub org that drop a marketing prefix
// from their domain's first label (e.g. getsentry.com -> also try "sentry").
const GENERIC_DOMAIN_PREFIXES = ['get', 'go', 'try', 'use', 'join', 'the', 'my'];

const NAME_SUFFIXES = new RegExp(
  '\\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|llp|plc|' +
  'sas|sasu|sarl|eurl|gmbh|ag|bv|nv|ab|as|oy|aps|srl|spa|kk|group|holdings|' +
  'technologies|technology|labs|software|systems)\\b\\.?',
  'g'
);

let ghCallCount = 0;

function sq(v) { return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }

// ---------------------------------------------------------------- D1 access
function fetchRows(limit) {
  const limitSql = Number.isInteger(limit) ? ` LIMIT ${limit}` : '';
  const raw = execSync(
    `WRANGLER_HOME=~/.wrangler npx wrangler d1 execute sourcing-scorer --remote --json ` +
    `--command "SELECT id,name,domain FROM companies WHERE domain IS NOT NULL AND tech_stack = '[]'${limitSql}"`,
    { cwd: path.join(__dirname, '..'), maxBuffer: 1024 * 1024 * 200 }
  ).toString();
  return JSON.parse(raw)[0].results;
}

// ------------------------------------------------------------ normalization
function normalizeDomain(domain) {
  let d = (domain || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return d.split('/')[0].trim();
}

function domainCandidates(domain) {
  const d = normalizeDomain(domain);
  if (!d) return [];
  const label = d.split('.')[0].replace(/[^a-z0-9]/g, '');
  if (!label) return [];
  const out = [label];
  for (const p of GENERIC_DOMAIN_PREFIXES) {
    if (label.startsWith(p) && label.length > p.length + 2) out.push(label.slice(p.length));
  }
  return out;
}

function normalizeCompanyName(name) {
  let n = (name || '').toLowerCase();
  n = n.replace(/[^a-z0-9\s]/g, ' ');
  n = n.replace(NAME_SUFFIXES, ' ');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function nameCandidate(name) {
  return normalizeCompanyName(name).replace(/\s+/g, '');
}

// Domain-derived candidates first (closest to the real brand), then the
// name-derived one, de-duped and length-guarded to avoid 1-2 char slugs.
function candidateSlugs(name, domain) {
  const seen = new Set();
  const out = [];
  for (const c of [...domainCandidates(domain), nameCandidate(name)]) {
    if (c && c.length >= 3 && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}

// ------------------------------------------------------------- match scoring
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Deliberately tight: exact match after normalization, or a couple of
// characters of edit distance (case/typo/punctuation noise only). NOT a
// substring/contains check — "Exakis Nelite" must not match plain "Exakis".
function namesFuzzyMatch(companyName, orgName) {
  const a = normalizeCompanyName(companyName);
  const b = normalizeCompanyName(orgName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const dist = levenshtein(a, b);
  const longer = Math.max(a.length, b.length);
  return dist / longer <= 0.15;
}

function blogMatchesDomain(blog, companyDomain) {
  if (!blog) return false;
  const blogHost = normalizeDomain(blog);
  const domain = normalizeDomain(companyDomain);
  if (!blogHost || !domain) return false;
  return blogHost === domain || blogHost.endsWith('.' + domain) || domain.endsWith('.' + blogHost);
}

// --------------------------------------------------------------- gh CLI calls
async function ghApi(pathAndQuery) {
  ghCallCount++;
  if (ghCallCount % RATE_CHECK_EVERY === 0) await maybeThrottle();
  try {
    const { stdout } = await execFileAsync('gh', ['api', pathAndQuery], { maxBuffer: 1024 * 1024 * 20 });
    return { ok: true, data: JSON.parse(stdout) };
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    if (/HTTP 404/.test(stderr)) return { ok: false, status: 404 };
    if (/HTTP 403/.test(stderr) || /HTTP 429/.test(stderr)) return { ok: false, status: 403, message: stderr.trim() };
    return { ok: false, status: 'error', message: stderr.trim() || err.message };
  }
}

async function ghApiWithRetry(pathAndQuery, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await ghApi(pathAndQuery);
    if (res.ok || res.status === 404) return res;
    last = res;
    if (res.status === 403 && i < attempts - 1) {
      const backoff = 2000 * Math.pow(2, i);
      console.log(`  403 on ${pathAndQuery}, backing off ${backoff}ms (attempt ${i + 1}/${attempts})`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    return res;
  }
  return last;
}

async function maybeThrottle() {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'rate_limit']);
    const info = JSON.parse(stdout);
    const remaining = info.resources.core.remaining;
    if (remaining < MIN_RATE_REMAINING) {
      const resetAt = info.resources.core.reset * 1000;
      const waitMs = Math.max(0, resetAt - Date.now()) + 5000;
      console.log(`rate limit low (${remaining} remaining) — sleeping ${Math.ceil(waitMs / 1000)}s until reset`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  } catch (e) {
    console.error('rate_limit check failed:', e.message);
  }
}

// ------------------------------------------------------------- language agg
function aggregateLanguages(repos) {
  const counts = new Map();
  for (const r of repos) {
    if (r.fork || r.archived) continue;
    const lang = (r.language || '').toLowerCase().trim();
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);
}

// ---------------------------------------------------------------- matching
async function matchCompany(company) {
  const slugs = candidateSlugs(company.name, company.domain);
  const tried = [];
  for (const slug of slugs) {
    const reposRes = await ghApiWithRetry(`orgs/${slug}/repos?per_page=100&type=public&sort=pushed`);
    if (!reposRes.ok) {
      tried.push({ slug, reason: reposRes.status === 404 ? '404' : `error: ${reposRes.message}` });
      continue; // cheap miss (404) or transient error on this candidate -> try next
    }
    const repos = reposRes.data;
    const profileRes = await ghApiWithRetry(`orgs/${slug}`);
    if (!profileRes.ok) {
      tried.push({ slug, reason: `profile lookup failed: ${profileRes.message}` });
      continue;
    }
    const profile = profileRes.data;
    const blogOk = blogMatchesDomain(profile.blog, company.domain);
    // Only the profile's explicit `name` field is fuzzy-matched — NOT `login`.
    // Logins are camelCase/compressed (e.g. "ElasticSuite") and slip under the
    // Levenshtein threshold against spaced company names too easily; that's
    // how "Elastic Suite" (id 2397) first false-matched an unrelated org.
    const nameOk = profile.name ? namesFuzzyMatch(company.name, profile.name) : false;
    if (!blogOk && !nameOk) {
      tried.push({ slug, reason: `org exists but uncorroborated (name=${profile.name}, blog=${profile.blog})` });
      continue;
    }
    const languages = aggregateLanguages(repos);
    if (!languages.length) {
      tried.push({ slug, reason: 'corroborated but no usable language signal' });
      continue;
    }
    return { matched: true, org: profile.login || slug, blogOk, nameOk, languages, reposConsidered: repos.length, tried };
  }
  return { matched: false, tried };
}

// ----------------------------------------------------------------- dry run
// Real rows pulled from remote D1 (2026-07-06) mixing well-known GitHub-org
// companies with lookalike-slug traps and small agencies with no public org.
const DRY_RUN_SAMPLE = [
  // --- expected matches (well-known GitHub orgs) ---
  { id: 67, name: 'GitGuardian', domain: 'gitguardian.com' },
  { id: 474, name: 'Sonatype', domain: 'sonatype.com' },
  { id: 567, name: 'HashiCorp', domain: 'hashicorp.com' },
  { id: 601, name: 'Snyk', domain: 'snyk.io' },
  { id: 1878, name: 'Cloudflare', domain: 'cloudflare.com' },
  { id: 1926, name: 'Datadog', domain: 'datadoghq.com' }, // domain-derived slug 404s; name-derived "datadog" hits
  { id: 1934, name: 'Elastic', domain: 'elastic.co' },
  { id: 1973, name: 'GitHub', domain: 'github.com' },
  { id: 1974, name: 'GitLab', domain: 'gitlab.com' }, // org confirmed via name, but its top-100-pushed repos carry no language signal -> correctly a miss for tech_stack, not a bug
  { id: 5124, name: 'Netlify', domain: 'netlify.com' },
  { id: 2738, name: 'Vercel', domain: 'vercelllc.com' }, // domain candidate 404s; name-derived "vercel" hits (blog mismatches domain, name matches)
  // --- lookalike-slug traps: an org exists at the slug but must NOT match ---
  { id: 2397, name: 'Elastic Suite', domain: 'elasticsuite.com' }, // org "ElasticSuite" exists (unrelated Magento module), no name/blog -> reject
  { id: 250, name: 'Artefact', domain: 'artefact.com' }, // org "ArteFact" exists (unrelated project), no name/blog -> reject
  { id: 300, name: 'NEXTON', domain: 'nexton-group.com' }, // org "nextongroup" exists, no name/blog -> reject
  // --- expected no-match: small consulting/staffing firms, no public org ---
  { id: 291, name: 'Starburst Aerospace', domain: 'starburst.aero' },
  { id: 295, name: 'MipihSIB', domain: 'mipihsib.fr' },
  { id: 297, name: 'Exakis Nelite', domain: 'exakis-nelite.com' },
  { id: 298, name: 'INFOGENE', domain: 'infogene.fr' },
  { id: 299, name: 'SQUAD - Cabinet de conseils et d’expertises', domain: 'squadgroup.com' },
];

// ------------------------------------------------------------ checkpointing
// A killed process (OOM, session recycle, ctrl-C) must not lose already-paid-for
// GitHub API work. Matched rows are flushed to a new numbered SQL file every
// CHECKPOINT_EVERY companies (not just once at the end), and every checked id
// (matched or not) is recorded so a restart skips work already done. Delete
// SEEN_IDS_FILE to force a full re-check (e.g. after months, in case new
// GitHub orgs appeared for previously-unmatched companies).
function loadSeenIds() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_IDS_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeenIds(set) {
  fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify([...set]));
}
function nextSqlFileIndex() {
  const existing = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
  const nums = existing
    .map(f => f.match(/^tech_stack_(\d+)\.sql$/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) + 1 : 0;
}
function flushMatches(pending, fileIndexRef) {
  if (!pending.length) return;
  const now = Date.now();
  const stmts = pending.map(u => `UPDATE companies SET tech_stack=${sq(u.tech_stack)}, updated_at=${now} WHERE id=${u.id};`);
  const name = `tech_stack_${String(fileIndexRef.i++).padStart(3, '0')}.sql`;
  fs.writeFileSync(path.join(OUT, name), stmts.join('\n') + '\n');
  console.log(`  checkpoint: wrote ${pending.length} rows to ${name}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  fs.mkdirSync(OUT, { recursive: true });

  const seenIds = dryRun ? new Set() : loadSeenIds();
  let rows = dryRun ? DRY_RUN_SAMPLE : fetchRows(limit);
  const totalFetched = rows.length;
  if (!dryRun && seenIds.size) {
    rows = rows.filter(r => !seenIds.has(r.id));
    console.log(`Resuming: ${totalFetched} fetched, ${totalFetched - rows.length} already checked (skipped), ${rows.length} remaining`);
  } else {
    console.log(`${dryRun ? 'DRY RUN (curated sample)' : 'Fetched from remote D1'}: ${rows.length} companies to check`);
  }

  const fileIndexRef = { i: dryRun ? 0 : nextSqlFileIndex() };
  const results = [];
  let pendingFlush = [];
  let next = 0;
  let checked = 0;
  async function worker() {
    while (next < rows.length) {
      const idx = next++;
      const company = rows[idx];
      const r = await matchCompany(company);
      results.push({ company, ...r });
      seenIds.add(company.id);
      checked++;
      if (r.matched) {
        console.log(`MATCH  [${company.id}] ${company.name} (${company.domain}) -> github.com/${r.org} :: ${JSON.stringify(r.languages)} (blogOk=${r.blogOk} nameOk=${r.nameOk}, ${r.reposConsidered} repos)`);
        if (!dryRun) pendingFlush.push({ id: company.id, tech_stack: JSON.stringify(r.languages) });
      } else if (dryRun) {
        console.log(`miss   [${company.id}] ${company.name} (${company.domain}) — ${r.tried.map(t => `${t.slug}: ${t.reason}`).join('; ') || 'no candidate slugs'}`);
      }
      if (!dryRun && checked % CHECKPOINT_EVERY === 0) {
        const m = results.filter(x => x.matched).length;
        console.log(`progress: ${checked}/${rows.length} checked, ${m} matched (${(100 * m / checked).toFixed(1)}%), ${ghCallCount} gh api calls`);
        const toFlush = pendingFlush; pendingFlush = [];
        flushMatches(toFlush, fileIndexRef);
        saveSeenIds(seenIds);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const matched = results.filter(r => r.matched);
  console.log(`\n${matched.length}/${rows.length} matched (${(100 * matched.length / rows.length).toFixed(1)}%), ${ghCallCount} total gh api calls`);

  if (dryRun) {
    console.log('\n--- dry run summary ---');
    for (const r of results) {
      const line = r.matched
        ? `github.com/${r.org} ${JSON.stringify(r.languages)}`
        : '(no confirmed org)';
      console.log(`${r.matched ? 'MATCH' : 'MISS '} ${r.company.name.padEnd(30)} ${r.company.domain.padEnd(22)} -> ${line}`);
    }
    console.log('\nDry run complete — no SQL written, no D1 writes performed.');
    return;
  }

  flushMatches(pendingFlush, fileIndexRef);
  saveSeenIds(seenIds);
  console.log(`done — ${fileIndexRef.i} SQL file(s) total in ${OUT}. Apply with wrangler d1 execute --remote --file, then rerun this script to pick up any companies that still need checking.`);
}

main().catch(e => { console.error(e); process.exit(1); });
