const SESSION_NAME = 'ss_session';
let _liveJobsCache = null, _liveJobsCacheAt = 0;
const LIVE_CACHE_MS = 5 * 60_000;
const SESSION_MS = 7 * 86400_000;

// ── password ──────────────────────────────────────────────────────
const KDF_ITERS = 600_000;        // current target; per-user kdf_iters supports old 10k hashes until rehash
const LOCK_AFTER = 10;            // failed attempts before lockout
const LOCK_MS = 15 * 60_000;
async function hashPassword(plain, salt, iters = KDF_ITERS) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(plain), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name:'PBKDF2', salt:enc.encode(salt), iterations:iters, hash:'SHA-256'},
    key, 256
  );
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── title filters (mirror of the client's auto-exclusion rules, for export) ──
const _CFO_TITLE_RE=/\b(cfo|chief financial officer|chief finance officer)\b|\b(directeur|directrice)\s+financi[eè]re?\b|\b(vp finance|vp of finance|head of finance|finance director|director of finance)\b/i;
const _ACCOUNTING_CTX_RE=/\b(accounting|comptabilit[eé]|consolidation|tax|fiscal)\b/i;
const _INTERIM_RE=/\b(interim|int[eé]rimaire|manager de transition|management de transition)\b/i;
const _EXPERT_CPT_RE=/\bexpert[-\s]comptable\b/i;
const _INHOUSE_RE=/\b(interne|intern[ao]|responsable|directeur|groupe)\b/i;
const isCfoTitle = t => _CFO_TITLE_RE.test(t) && !_ACCOUNTING_CTX_RE.test(t);
const isInterim = t => _INTERIM_RE.test(t);
const isExpertComptable = t => _EXPERT_CPT_RE.test(t) && !_INHOUSE_RE.test(t);

// ── knowledge base: normalization + LLM classification ────────────
// Facet taxonomy shared with the client (fam keys mirror ROLE_FAMILIES).
const KB_FAMILIES = ['bdr_sdr','ae_exec','channel','csm','acct_mgmt','solutions','security_research','security_ops','security_eng','ai_ml','data_eng','devops','qa_test','it_ops','software','product','design','growth_mkt','content_mkt','field_mkt','brand_comms','sales_ops','fp_a','accounting','finance','legal','people_hr','other'];
const KB_SENIORITIES = ['junior','mid','senior','lead','exec'];
const KB_SETTINGS = ['in_house','cabinet','freelance','interim','unknown'];
const KB_FLAGS = ['own_practice','student','seeking'];
const KB_COMPANY_KINDS = ['company','accounting_firm','consulting_esn','agency','recruitment','freelance_self','education','public_sector','unknown'];
const KB_MODEL = 'claude-opus-4-8';
const KB_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';  // Workers AI fallback when no Anthropic key
const KB_ITEMS_PER_CALL = 60;   // titles/companies per Claude request
const KB_ITEMS_PER_CALL_AI = 40; // smaller batches for llama
const KB_MAX_LLM_CALLS = 8;     // per Worker invocation; the client loops until pending=0

function kbNormTitle(raw){
  let n = String(raw||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu,' ')
    .replace(/\b[hfmwx]\s*\/\s*[hfmwx](\s*\/\s*[hfmwxd])?\b/g,' ')  // h/f, f/h/x, m/w/d…
    .replace(/\b(cdi|cdd)\b/g,' ');
  if(n.includes('|')) n = n.split('|')[0];
  n = n.replace(/[(){}\[\]«»"“”'’#*_,;:!?]/g,' ').replace(/\s*[–—/]\s*/g,' ').replace(/\s+-\s+/g,' ').replace(/\s+/g,' ').trim();
  return n;
}
function kbNormCompany(raw){
  return String(raw||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/gu,' ')
    .replace(/[(){}\[\]«»"“”'’#*_,;:!?.]/g,' ')
    .replace(/\b(sasu|sas|sarl|eurl|spa|gmbh|ltd|llc|inc|plc|bv|ag|srl|sa)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}

const KB_TITLE_PROMPT = `You classify LinkedIn job titles for a tech-recruiting tool (GitGuardian, a Paris code-security company). Titles are mostly French or English. For each input title return:
- fam: the role family. Hints for ambiguous cases: accounting = comptabilité, audit interne/externe, tax, treasury, consolidation, commissariat aux comptes; fp_a = contrôle de gestion, FP&A, financial/business controller; finance = CFO, DAF, RAF, direction financière (leadership over the whole finance function); ae_exec = quota-carrying sales, sales leadership, general management; bdr_sdr = outbound prospecting; sales_ops = revenue/sales operations & enablement; security_eng = security engineering, appsec, cloud security, CISO; security_ops = SOC/IAM/GRC analysts; security_research = vulnerability/malware/threat research; software = software development & engineering management; it_ops = internal IT, sysadmin, helpdesk; people_hr = HR & recruiting; other = nothing in the enum fits.
- seniority: junior (intern, apprentice, alternant, stagiaire, <2y) | mid (default) | senior (senior, confirmé, expert) | lead (manager, responsable, chef, team lead, principal, staff) | exec (director, directeur/directrice, VP, head of, C-level, partner, founder).
- setting: in_house (employee doing this function inside one company) | cabinet (works at a client-serving professional firm: cabinet d'expertise comptable, audit — EY, KPMG, Deloitte, PwC, Mazars… — law firm, client-mission consulting; "collaborateur comptable" and "expert-comptable" in a cabinet belong here) | freelance (independent, self-employed, en portage, consultant indépendant) | interim (interim/transition management, intérimaire) | unknown (cannot tell from the title).
- flags: subset of [own_practice (owns/founded their firm — fondateur/associé of a small cabinet, expert-comptable with their own office), student, seeking (open to work, en recherche)]. Empty if none.
Judge from the title text alone. When a title mixes several roles, pick the dominant one. The i field must echo the input index.`;

const KB_COMPANY_PROMPT = `You classify employer names from LinkedIn profiles for a Paris tech-recruiting tool. Many are French. For each name return kind:
- accounting_firm: cabinet d'expertise comptable / audit / commissariat aux comptes (names with "expertise", "audit", "& associés" in an accounting context; EY, KPMG, Deloitte, PwC, Mazars, Grant Thornton, BDO, In Extenso, Fiducial…)
- consulting_esn: consulting firms and ESN / IT services (Capgemini, Accenture, Sopra Steria…)
- agency: marketing / creative / communication agencies
- recruitment: recruiting, staffing or interim agencies (Michael Page, Hays, Fed Finance, Adecco…)
- freelance_self: the "company" is the person themself (freelance, indépendant, auto-entrepreneur, EI, portage, or just a person's name styled as a business)
- education: schools and universities
- public_sector: government, public administration
- company: an ordinary operating company (startup, scale-up, corporate, SME)
- unknown: too ambiguous to tell.
Judge from the name alone; prefer company or unknown over guessing an exotic kind. The i field must echo the input index.`;

// Workers AI fallback: same prompts/schema as the Anthropic path, but llama
// respects schemas less reliably, so every item is validated against the enums
// and invalid ones are dropped (they stay "pending" and get retried).
async function kbClassifyWorkersAI(env, kind, items, itemSchema){
  const isTitle = kind==='title';
  const resp = await env.AI.run(KB_AI_MODEL, {
    messages: [
      {role:'system', content: isTitle ? KB_TITLE_PROMPT : KB_COMPANY_PROMPT},
      {role:'user', content: JSON.stringify(items.map((t,i)=>({i,[isTitle?'title':'company']:t})))},
    ],
    max_tokens: 6000,
    response_format: {type:'json_schema', json_schema:{
      type:'object',properties:{results:{type:'array',items:itemSchema}},required:['results'],
    }},
  });
  let out = resp && resp.response;
  if (typeof out === 'string'){ try { out = JSON.parse(out); } catch { return {results:[]}; } }
  const raw = Array.isArray(out && out.results) ? out.results : [];
  const results = [];
  for (const it of raw){
    if (!it || !Number.isInteger(it.i)) continue;
    if (isTitle){
      if (!KB_FAMILIES.includes(it.fam) || !KB_SENIORITIES.includes(it.seniority) || !KB_SETTINGS.includes(it.setting)) continue;
      const flags = Array.isArray(it.flags) ? it.flags.filter(f=>KB_FLAGS.includes(f)) : [];
      results.push({i:it.i,fam:it.fam,seniority:it.seniority,setting:it.setting,flags});
    } else {
      if (!KB_COMPANY_KINDS.includes(it.kind)) continue;
      results.push({i:it.i,kind:it.kind});
    }
  }
  return {results};
}

async function kbClassifyLLM(env, kind, items){
  const isTitle = kind==='title';
  const itemSchema = isTitle ? {
    type:'object',
    properties:{i:{type:'integer'},fam:{type:'string',enum:KB_FAMILIES},seniority:{type:'string',enum:KB_SENIORITIES},setting:{type:'string',enum:KB_SETTINGS},flags:{type:'array',items:{type:'string',enum:KB_FLAGS}}},
    required:['i','fam','seniority','setting','flags'],additionalProperties:false,
  } : {
    type:'object',
    properties:{i:{type:'integer'},kind:{type:'string',enum:KB_COMPANY_KINDS}},
    required:['i','kind'],additionalProperties:false,
  };
  if (!env.ANTHROPIC_API_KEY && env.AI) return kbClassifyWorkersAI(env, kind, items, itemSchema);
  const body = JSON.stringify({
    model: KB_MODEL,
    max_tokens: 8000,
    system: isTitle ? KB_TITLE_PROMPT : KB_COMPANY_PROMPT,
    messages: [{role:'user',content:JSON.stringify(items.map((t,i)=>({i,[isTitle?'title':'company']:t})))}],
    output_config: {format:{type:'json_schema',schema:{
      type:'object',properties:{results:{type:'array',items:itemSchema}},required:['results'],additionalProperties:false,
    }}},
  });
  let lastErr;
  for (let attempt=0; attempt<2; attempt++){
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body,
      });
      if (!res.ok){
        const detail = (await res.text().catch(()=>'')).slice(0,300);
        lastErr = new Error(`Anthropic ${res.status}: ${detail}`);
        if (res.status>=500 || res.status===429) continue;  // retryable
        throw lastErr;
      }
      const msg = await res.json();
      if (msg.stop_reason==='refusal') return {results:[]};
      const text = (msg.content||[]).find(b=>b.type==='text')?.text||'';
      return JSON.parse(text);
    } catch(e){ lastErr=e; }
  }
  throw lastErr;
}

// ── company business-model classification (docs/specs/2026-07-02-company-db-reframe.md) ──
// No dataset carries this field; the spec calls for an LLM batch pass. Stateless —
// callers persist results themselves (see pipeline/08_business_model.py).
const CB_MODELS = ['b2b_saas','b2c','marketplace','services','other'];
const CB_PROMPT = `You classify companies' business model for a recruiting/sourcing tool. For each company (name + industry given) return business_model:
- b2b_saas: sells software/subscriptions to other businesses (most cybersecurity, devtools, enterprise software, fintech infrastructure vendors).
- b2c: sells products or subscriptions directly to consumers.
- marketplace: two-sided platform connecting buyers and sellers/providers.
- services: consulting, agencies, staffing, IT services, professional services firms (revenue is billed work, not a product).
- other: hardware manufacturers, public sector, education, or anything that doesn't fit above.
Judge from the name and industry alone; when uncertain between b2b_saas and other software categories, prefer b2b_saas for software/tech companies. The i field must echo the input index.`;
async function classifyBusinessModel(env, items){
  const schema = {type:'object',properties:{i:{type:'integer'},business_model:{type:'string',enum:CB_MODELS}},required:['i','business_model'],additionalProperties:false};
  const body = {
    system: CB_PROMPT,
    userContent: JSON.stringify(items.map((c,i)=>({i,name:c.name,industry:c.industry||''}))),
    schema,
  };
  if (env.ANTHROPIC_API_KEY){
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body: JSON.stringify({
        model: KB_MODEL, max_tokens: 6000, system: body.system,
        messages: [{role:'user',content:body.userContent}],
        output_config: {format:{type:'json_schema',schema:{type:'object',properties:{results:{type:'array',items:schema}},required:['results'],additionalProperties:false}}},
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const msg = await res.json();
    const text = (msg.content||[]).find(b=>b.type==='text')?.text||'{}';
    return JSON.parse(text).results||[];
  }
  if (!env.AI) throw new Error('No classifier backend');
  const resp = await env.AI.run(KB_AI_MODEL, {
    messages: [{role:'system',content:body.system},{role:'user',content:body.userContent}],
    max_tokens: 4000,
    response_format: {type:'json_schema', json_schema:{type:'object',properties:{results:{type:'array',items:schema}},required:['results']}},
  });
  let out = resp && resp.response;
  if (typeof out === 'string'){ try { out = JSON.parse(out); } catch { return []; } }
  const raw = Array.isArray(out && out.results) ? out.results : [];
  return raw.filter(it=>it && Number.isInteger(it.i) && CB_MODELS.includes(it.business_model));
}

async function kbLookup(env, table, col, norms){
  const map = new Map();
  for (let i=0;i<norms.length;i+=80){
    const chunk = norms.slice(i,i+80);
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col} IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
    for (const r of rows.results){
      if (table==='title_facets'){
        let flags=[]; try{flags=JSON.parse(r.flags||'[]')}catch{}
        map.set(r.title_norm,{fam:r.fam,seniority:r.seniority,setting:r.setting,flags,source:r.source});
      } else map.set(r.company_norm,{kind:r.kind,source:r.source});
    }
  }
  return map;
}

// ── session ───────────────────────────────────────────────────────
function getToken(request) {
  const m = (request.headers.get('Cookie')||'').match(new RegExp(`(?:^|; )${SESSION_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

async function getSession(request, env) {
  const token = getToken(request);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT user_id, created_at FROM sessions WHERE token=?').bind(token).first();
  if (!row || Date.now()-row.created_at > SESSION_MS) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return null;
  }
  const user = await env.DB.prepare('SELECT id, name FROM users WHERE id=?').bind(row.user_id).first();
  return user ? {id:user.id, name:user.name, token} : null;
}

function setCookie(token, clear) {
  return `${SESSION_NAME}=${token||''}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${clear?0:SESSION_MS/1000}`;
}

// ── user seeding ──────────────────────────────────────────────────
async function seedUsersIfEmpty(env) {
  const {n} = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
  if (n > 0) return;
  const defs = [
    {id:env.USER1_ID||'kevin', name:env.USER1_NAME||'Kevin',   pass:env.USER1_PASS},
    {id:env.USER2_ID||'user2', name:env.USER2_NAME||'User 2',  pass:env.USER2_PASS},
    {id:env.USER3_ID||'user3', name:env.USER3_NAME||'User 3',  pass:env.USER3_PASS},
    {id:env.USER4_ID||'user4', name:env.USER4_NAME||'User 4',  pass:env.USER4_PASS},
  ].filter(u=>u.pass);
  for (const u of defs) {
    const salt = crypto.randomUUID();
    const hash = await hashPassword(u.pass, salt);
    await env.DB.prepare('INSERT OR IGNORE INTO users (id,name,password_hash,password_salt,kdf_iters) VALUES(?,?,?,?,?)')
      .bind(u.id, u.name, hash, salt, KDF_ITERS).run();
  }
}

// ── auth endpoints ────────────────────────────────────────────────
async function handleLogin(request, env) {
  await seedUsersIfEmpty(env);
  let body;
  try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
  const user = await env.DB.prepare('SELECT id,name,password_hash,password_salt,kdf_iters,failed_count,locked_until FROM users WHERE id=?')
    .bind((body.username||'').toLowerCase().trim()).first();
  if (!user) {
    // Burn the same KDF cost as a real check so timing doesn't reveal valid usernames
    await hashPassword(body.password||'', 'dummy-salt-for-constant-timing');
    return err(401,'Invalid credentials');
  }
  const now = Date.now();
  if ((user.locked_until||0) > now) return err(429,'Too many failed attempts — try again in a few minutes');
  const iters = user.kdf_iters || 10_000;
  const ok = (await hashPassword(body.password||'', user.password_salt, iters)) === user.password_hash;
  if (!ok) {
    const fails = (user.failed_count||0) + 1;
    if (fails >= LOCK_AFTER) await env.DB.prepare('UPDATE users SET failed_count=0, locked_until=? WHERE id=?').bind(now+LOCK_MS, user.id).run();
    else await env.DB.prepare('UPDATE users SET failed_count=? WHERE id=?').bind(fails, user.id).run();
    return err(401,'Invalid credentials');
  }
  if (user.failed_count || user.locked_until) {
    await env.DB.prepare('UPDATE users SET failed_count=0, locked_until=0 WHERE id=?').bind(user.id).run();
  }
  if (iters < KDF_ITERS) {
    // Transparent upgrade of legacy 10k-iteration hashes
    const salt = crypto.randomUUID();
    const hash = await hashPassword(body.password||'', salt, KDF_ITERS);
    await env.DB.prepare('UPDATE users SET password_hash=?, password_salt=?, kdf_iters=? WHERE id=?').bind(hash, salt, KDF_ITERS, user.id).run();
  }
  const token = crypto.randomUUID();
  await env.DB.prepare('DELETE FROM sessions WHERE created_at<?').bind(Date.now()-SESSION_MS).run();
  await env.DB.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES(?,?,?)').bind(token,user.id,Date.now()).run();
  return new Response(JSON.stringify({ok:true,user:{id:user.id,name:user.name}}), {
    headers:{'Content-Type':'application/json','Set-Cookie':setCookie(token,false)},
  });
}

async function handleLogout(request, env) {
  const token = getToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
  return new Response(null, {status:302, headers:{Location:'/', 'Set-Cookie':setCookie('',true)}});
}

// ── API router ────────────────────────────────────────────────────
async function handleAPI(request, url, session, env) {
  const uid = session.id;
  const {method, pathname:path} = {method:request.method, pathname:url.pathname};

  if (path==='/api/me' && method==='GET') return ok({id:session.id, name:session.name});

  // decisions
  if (path==='/api/decisions') {
    if (method==='GET') {
      const rows = await env.DB.prepare('SELECT candidate_key,action FROM decisions WHERE user_id=?').bind(uid).all();
      const dec = {};
      rows.results.forEach(r=>{dec[r.candidate_key]=r.action});
      return ok(dec);
    }
    if (method==='POST') {
      const {key,action} = await request.json();
      if (!key) return err(400,'Missing key');
      if (action && action !== 'kept' && action !== 'excl' && action !== 'view') return err(400,'Invalid action');
      if (!action) await env.DB.prepare('DELETE FROM decisions WHERE user_id=? AND candidate_key=?').bind(uid,key).run();
      else await env.DB.prepare('INSERT OR REPLACE INTO decisions (user_id,candidate_key,action) VALUES(?,?,?)').bind(uid,key,action).run();
      return ok({ok:true});
    }
    if (method==='DELETE') {
      await env.DB.prepare('DELETE FROM decisions WHERE user_id=?').bind(uid).run();
      return ok({ok:true});
    }
  }

  // settings
  if (path==='/api/settings') {
    if (method==='GET') {
      const row = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id=?').bind(uid).first();
      let usCities = []; try { usCities = JSON.parse(row?.us_cities || '[]'); } catch {}
      return ok(row ? {hotThreshold:row.hot_threshold, filterCFO:!!row.filter_cfo, filterInterim:!!row.filter_interim, filterExpertComptable:!!row.filter_expert_comptable, usCities}
                    : {hotThreshold:65, filterCFO:true, filterInterim:true, filterExpertComptable:true, usCities:[]});
    }
    if (method==='PUT') {
      const s = await request.json();
      await env.DB.prepare('INSERT OR REPLACE INTO user_settings (user_id,hot_threshold,filter_cfo,filter_interim,filter_expert_comptable,us_cities) VALUES(?,?,?,?,?,?)')
        .bind(uid, s.hotThreshold??65, s.filterCFO?1:0, s.filterInterim?1:0, s.filterExpertComptable?1:0, JSON.stringify(Array.isArray(s.usCities)?s.usCities:[])).run();
      return ok({ok:true});
    }
  }

  // live Teamtailor jobs — must come before /api/jobs to avoid prefix collision
  if (path==='/api/jobs/live' && method==='GET') {
    const now = Date.now();
    if (_liveJobsCache && now - _liveJobsCacheAt < LIVE_CACHE_MS) return ok(_liveJobsCache);
    try {
      const res = await fetch('https://careers.gitguardian.com/jobs.json');
      const data = await res.json();
      _liveJobsCache = (data.items || []).map(j => ({id:j.id, title:j.title, url:j.url, date_published:j.date_published}));
      _liveJobsCacheAt = now;
      return ok(_liveJobsCache);
    } catch {
      return ok(_liveJobsCache || []);
    }
  }

  if (path==='/api/candidates/counts' && method==='GET') {
    const s = await env.DB.prepare('SELECT hot_threshold FROM user_settings WHERE user_id=?').bind(uid).first();
    const ht = s?.hot_threshold ?? 65;
    const rows = await env.DB.prepare(
      'SELECT job_id, COUNT(*) as total, SUM(CASE WHEN score>=? THEN 1 ELSE 0 END) as hot, SUM(CASE WHEN score>=40 AND score<? THEN 1 ELSE 0 END) as warm FROM candidates WHERE user_id=? GROUP BY job_id'
    ).bind(ht, ht, uid).all();
    const counts = {};
    rows.results.forEach(r => { counts[r.job_id] = {total:r.total, hot:r.hot||0, warm:r.warm||0}; });
    return ok(counts);
  }

  // ── knowledge base ──
  // Cache-first classification: unique raw titles/companies in, facets out.
  // Only cache misses go to Claude (up to KB_MAX_LLM_CALLS batches per call);
  // the client re-calls while `pending` > 0.
  if (path==='/api/classify' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const titles = (Array.isArray(body.titles)?body.titles:[]).filter(t=>typeof t==='string').slice(0,400);
    const companies = (Array.isArray(body.companies)?body.companies:[]).filter(t=>typeof t==='string').slice(0,400);
    const tNorm = new Map(); titles.forEach(t=>{const n=kbNormTitle(t); if(n)tNorm.set(t,n)});
    const cNorm = new Map(); companies.forEach(c=>{const n=kbNormCompany(c); if(n)cNorm.set(c,n)});

    const tRows = await kbLookup(env,'title_facets','title_norm',[...new Set(tNorm.values())]);
    const cRows = await kbLookup(env,'company_facts','company_norm',[...new Set(cNorm.values())]);
    const stats = {titleCached:tRows.size, companyCached:cRows.size, llmCalls:0};

    const tMiss = [...new Set([...tNorm.values()].filter(n=>!tRows.has(n)))];
    const cMiss = [...new Set([...cNorm.values()].filter(n=>!cRows.has(n)))];
    const batches = [];
    // No backend → cache hits still work; misses just never resolve (client
    // falls back to keyword scoring for them).
    const hasBackend = !!(env.ANTHROPIC_API_KEY || env.AI);
    const perCall = env.ANTHROPIC_API_KEY ? KB_ITEMS_PER_CALL : KB_ITEMS_PER_CALL_AI;
    let budget = hasBackend ? KB_MAX_LLM_CALLS : 0;
    for (let i=0;i<tMiss.length&&budget>0;i+=perCall,budget--) batches.push({kind:'title',items:tMiss.slice(i,i+perCall)});
    for (let i=0;i<cMiss.length&&budget>0;i+=perCall,budget--) batches.push({kind:'company',items:cMiss.slice(i,i+perCall)});

    let llmError = hasBackend ? null : 'No classifier backend (ANTHROPIC_API_KEY or AI binding)';
    const now = Date.now();
    const settled = await Promise.allSettled(batches.map(b=>kbClassifyLLM(env,b.kind,b.items)));
    const inserts = [];
    settled.forEach((r,bi)=>{
      const b = batches[bi];
      if (r.status==='rejected'){ llmError = String(r.reason?.message||r.reason).slice(0,300); return; }
      stats.llmCalls++;
      for (const it of (r.value.results||[])){
        const norm = b.items[it.i];
        if (norm===undefined) continue;
        if (b.kind==='title'){
          tRows.set(norm,{fam:it.fam,seniority:it.seniority,setting:it.setting,flags:it.flags||[],source:'llm'});
          inserts.push(env.DB.prepare('INSERT OR IGNORE INTO title_facets (title_norm,fam,seniority,setting,flags,source,updated_at) VALUES(?,?,?,?,?,?,?)')
            .bind(norm,it.fam,it.seniority,it.setting,JSON.stringify(it.flags||[]),'llm',now));
        } else {
          cRows.set(norm,{kind:it.kind,source:'llm'});
          inserts.push(env.DB.prepare('INSERT OR IGNORE INTO company_facts (company_norm,kind,source,updated_at) VALUES(?,?,?,?)')
            .bind(norm,it.kind,'llm',now));
        }
      }
    });
    for (let i=0;i<inserts.length;i+=80) await env.DB.batch(inserts.slice(i,i+80));

    const outT = {}, outC = {};
    for (const [raw,n] of tNorm){ const f=tRows.get(n); if(f) outT[raw]=f; }
    for (const [raw,n] of cNorm){ const f=cRows.get(n); if(f) outC[raw]=f; }
    const pending = [...tNorm.values()].filter(n=>!tRows.has(n)).length
                  + [...cNorm.values()].filter(n=>!cRows.has(n)).length;
    return ok({titles:outT, companies:outC, pending, llmError, stats});
  }

  // learned keep/exclude counters per job family (shared team-wide)
  if (path==='/api/weights' && method==='GET') {
    const family = (url.searchParams.get('family')||'other').slice(0,40);
    const rows = await env.DB.prepare('SELECT facet_key,keeps,excludes FROM facet_weights WHERE family_id=?').bind(family).all();
    const out = {};
    rows.results.forEach(r=>{ out[r.facet_key]={k:r.keeps,x:r.excludes}; });
    return ok(out);
  }

  // a triage decision (or its undo) updates the family's facet counters
  if (path==='/api/learn' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const family = (typeof body.family==='string' ? body.family.trim().slice(0,40) : '');
    const f = body.facets;
    if (!family || !f || typeof f!=='object') return err(400,'Missing family/facets');
    const dk = (body.next==='kept'?1:0) - (body.prev==='kept'?1:0);
    const dx = (body.next==='excl'?1:0) - (body.prev==='excl'?1:0);
    if (!dk && !dx) return ok({ok:true});
    const keys = [];
    if (KB_FAMILIES.includes(f.fam)) keys.push('fam='+f.fam);
    if (KB_SENIORITIES.includes(f.seniority)) keys.push('seniority='+f.seniority);
    if (KB_SETTINGS.includes(f.setting)) keys.push('setting='+f.setting);
    if (!keys.length) return ok({ok:true});
    await env.DB.batch(keys.map(key=>env.DB.prepare(
      `INSERT INTO facet_weights (family_id,facet_key,keeps,excludes) VALUES(?,?,?,?)
       ON CONFLICT(family_id,facet_key) DO UPDATE SET keeps=MAX(0,keeps+?), excludes=MAX(0,excludes+?)`
    ).bind(family,key,Math.max(0,dk),Math.max(0,dx),dk,dx)));
    return ok({ok:true});
  }

  // manual facet correction — strongest learning signal, never overwritten by the LLM
  if (path==='/api/facets/title' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const norm = kbNormTitle(body.title||'');
    const f = body.facets||{};
    if (!norm) return err(400,'Missing title');
    if (!KB_FAMILIES.includes(f.fam) || !KB_SENIORITIES.includes(f.seniority) || !KB_SETTINGS.includes(f.setting)) return err(400,'Invalid facets');
    const flags = JSON.stringify(Array.isArray(f.flags)?f.flags.filter(x=>KB_FLAGS.includes(x)):[]);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO title_facets (title_norm,fam,seniority,setting,flags,source,updated_at) VALUES(?,?,?,?,?,'manual',?)
       ON CONFLICT(title_norm) DO UPDATE SET fam=?,seniority=?,setting=?,flags=?,source='manual',updated_at=?`
    ).bind(norm,f.fam,f.seniority,f.setting,flags,now,f.fam,f.seniority,f.setting,flags,now).run();
    return ok({ok:true});
  }

  // jobs
  if (path==='/api/jobs') {
    if (method==='GET') {
      const rows = await env.DB.prepare('SELECT id,title FROM jobs WHERE user_id=? ORDER BY sort_order').bind(uid).all();
      return ok(rows.results);
    }
    if (method==='POST') {
      const {title} = await request.json();
      if (!title) return err(400,'Missing title');
      const id = 'custom_'+crypto.randomUUID().slice(0,8);
      const {m} = await env.DB.prepare('SELECT MAX(sort_order) as m FROM jobs WHERE user_id=?').bind(uid).first();
      await env.DB.prepare('INSERT INTO jobs (id,user_id,title,sort_order) VALUES(?,?,?,?)').bind(id,uid,title,(m??-1)+1).run();
      return ok({id,title});
    }
  }
  const jobDel = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobDel && method==='DELETE') {
    const jid = jobDel[1];
    const likePat = jid.replace(/[\\%_]/g, m=>'\\'+m)+'::%';
    await env.DB.batch([
      env.DB.prepare('DELETE FROM jobs WHERE user_id=? AND id=?').bind(uid,jid),
      env.DB.prepare('DELETE FROM candidates WHERE user_id=? AND job_id=?').bind(uid,jid),
      env.DB.prepare("DELETE FROM decisions WHERE user_id=? AND candidate_key LIKE ? ESCAPE '\\'").bind(uid,likePat),
    ]);
    return ok({ok:true});
  }

  // imports per job (must come before /candidates to avoid partial-match issues)
  const jobImports = path.match(/^\/api\/jobs\/([^/]+)\/imports$/);
  if (jobImports) {
    const jobId = jobImports[1];
    if (method === 'GET') {
      const s = await env.DB.prepare('SELECT hot_threshold FROM user_settings WHERE user_id=?').bind(uid).first();
      const ht = s?.hot_threshold ?? 65;
      const rows = await env.DB.prepare(
        `SELECT c.import_name, MIN(c.import_date) as import_date, COUNT(*) as total,
          SUM(CASE WHEN c.score >= ? THEN 1 ELSE 0 END) as hot,
          SUM(CASE WHEN c.score >= 40 AND c.score < ? THEN 1 ELSE 0 END) as warm,
          SUM(CASE WHEN d.action = 'kept' THEN 1 ELSE 0 END) as kept,
          SUM(CASE WHEN d.action = 'excl' THEN 1 ELSE 0 END) as skipped,
          SUM(CASE WHEN d.action = 'view' THEN 1 ELSE 0 END) as viewed
        FROM candidates c
        LEFT JOIN decisions d ON d.user_id = c.user_id AND d.candidate_key = c.job_id || '::' || (CASE WHEN c.name='' THEN c.linkedin_url ELSE c.name END) || '|' || c.company
        WHERE c.user_id = ? AND c.job_id = ?
        GROUP BY c.import_name ORDER BY MIN(c.import_date) ASC`
      ).bind(ht, ht, uid, jobId).all();
      return ok(rows.results);
    }
    if (method === 'DELETE') {
      let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
      const importName = (body.importName ?? '');
      await env.DB.prepare('DELETE FROM candidates WHERE user_id=? AND job_id=? AND import_name=?').bind(uid, jobId, importName).run();
      return ok({ ok: true });
    }
  }

  // candidate CRUD per job
  const jobCand = path.match(/^\/api\/jobs\/([^/]+)\/candidates$/);
  if (jobCand) {
    const jobId = jobCand[1];

    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return err(400, 'Invalid JSON'); }
      const list = body.candidates;
      const importName = (body.importName || '').trim().slice(0, 120);
      const importDate = Date.now();
      if (!Array.isArray(list)) return err(400, 'candidates must be array');
      if (!list.length) return ok({ ok: true, count: 0, skipped: 0 });
      const stmts = list.map(c => {
        // Mirrors the frontend's ckey(): nameless (anonymized) leads fall back to their URL
        const dedup = `${c.name||c.linkedin_url||c.url||''}|${c.company||''}`;
        return env.DB.prepare(
          'INSERT OR IGNORE INTO candidates (user_id,job_id,dedup_key,name,first_name,last_name,company,title,linkedin_url,score,reasons,import_name,import_date,facets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(uid, jobId, dedup, c.name||'', c.first_name||'', c.last_name||'', c.company||'', c.title||'', c.linkedin_url||c.url||'', c.score||0, JSON.stringify(c.reasons||[]), importName, importDate, c.facets?JSON.stringify(c.facets):'');
      });
      const results = await env.DB.batch(stmts);
      const count = results.reduce((s, r) => s + (r.meta?.changes || 0), 0);
      return ok({ ok: true, count, skipped: list.length - count });
    }

    if (method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT name,first_name,last_name,company,title,linkedin_url,score,reasons,import_name,facets FROM candidates WHERE user_id=? AND job_id=? ORDER BY score DESC'
      ).bind(uid, jobId).all();
      return ok(rows.results.map(r => {
        let facets = null; try { facets = r.facets ? JSON.parse(r.facets) : null; } catch {}
        return {
          name: r.name,
          firstName: r.first_name,
          lastName: r.last_name,
          company: r.company,
          title: r.title,
          url: r.linkedin_url,
          score: r.score,
          reasons: JSON.parse(r.reasons || '[]'),
          importName: r.import_name || '',
          facets,
        };
      }));
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM candidates WHERE user_id=? AND job_id=?').bind(uid, jobId).run();
      return ok({ ok: true });
    }
  }

  // CSV export of kept candidates for a job
  const jobExport = path.match(/^\/api\/jobs\/([^/]+)\/export\.csv$/);
  if (jobExport && method === 'GET') {
    const jobId = jobExport[1];
    const keptRows = await env.DB.prepare(
      'SELECT candidate_key FROM decisions WHERE user_id=? AND action=?'
    ).bind(uid, 'kept').all();
    const keptSet = new Set(keptRows.results.map(r => r.candidate_key));
    const cands = await env.DB.prepare(
      'SELECT name,company,title,linkedin_url,score,reasons FROM candidates WHERE user_id=? AND job_id=? ORDER BY score DESC'
    ).bind(uid, jobId).all();
    // Apply the same blocks/patterns/filters the triage UI applies, so the export
    // can't contain candidates the recruiter believes were removed. Legacy
    // pre-migration 'name|company' keys are no longer honored (they matched every job).
    const blkRows = await env.DB.prepare("SELECT term FROM blocks WHERE user_id=? OR user_id=''").bind(uid).all();
    const blockTerms = blkRows.results.map(r => r.term.toLowerCase());
    const patRows = await env.DB.prepare('SELECT pattern_regex FROM hidden_patterns WHERE user_id=?').bind(uid).all();
    const patterns = patRows.results.map(r => { try { return new RegExp(r.pattern_regex,'i') } catch { return null } }).filter(Boolean);
    const st = await env.DB.prepare('SELECT filter_cfo,filter_interim,filter_expert_comptable FROM user_settings WHERE user_id=?').bind(uid).first();
    const f = st ? {cfo:!!st.filter_cfo, interim:!!st.filter_interim, ec:!!st.filter_expert_comptable} : {cfo:true, interim:true, ec:true};
    const hiddenTitle = t => (f.cfo&&isCfoTitle(t))||(f.interim&&isInterim(t))||(f.ec&&isExpertComptable(t))||patterns.some(re=>re.test(t));
    const blocked = co => { const n=(co||'').toLowerCase(); return blockTerms.some(t=>n.includes(t)) };
    const kept = cands.results.filter(c =>
      keptSet.has(`${jobId}::${c.name||c.linkedin_url||''}|${c.company}`) && !blocked(c.company) && !hiddenTitle(c.title)
    );
    const rows = [['Name','Title','Company','Score','LinkedIn','Reasons']];
    kept.forEach(c => rows.push([
      c.name, c.title, c.company, String(c.score), c.linkedin_url,
      JSON.parse(c.reasons||'[]').join(' | ')
    ]));
    // Neutralize spreadsheet formula injection (=, +, -, @) from untrusted profile data
    const cell = v => { const s = String(v); return /^[=+\-@\t\r]/.test(s) ? "'"+s : s; };
    const csv = '﻿' + rows.map(r =>
      r.map(v => `"${cell(v).replace(/"/g,'""')}"`).join(',')
    ).join('\n');
    const slug = jobId.replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,40);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="kept-${slug}.csv"`,
      },
    });
  }

  // shared (team-wide) block terms live under user_id=''
  if (path==='/api/blocks/shared' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const term = (typeof body.term==='string' ? body.term : '').trim();
    if (!term) return err(400,'Missing term');
    await env.DB.prepare("INSERT OR IGNORE INTO blocks (user_id,term) VALUES('',?)").bind(term).run();
    return ok({ok:true});
  }
  const sharedDel = path.match(/^\/api\/blocks\/shared\/(.+)$/);
  if (sharedDel && method==='DELETE') {
    await env.DB.prepare("DELETE FROM blocks WHERE user_id='' AND term=?").bind(decodeURIComponent(sharedDel[1])).run();
    return ok({ok:true});
  }

  // blocks (terms + hidden patterns combined)
  if (path==='/api/blocks') {
    if (method==='GET') {
      const terms = await env.DB.prepare('SELECT term FROM blocks WHERE user_id=?').bind(uid).all();
      const shared = await env.DB.prepare("SELECT term FROM blocks WHERE user_id=''").all();
      const pats  = await env.DB.prepare('SELECT pattern_label,pattern_regex FROM hidden_patterns WHERE user_id=?').bind(uid).all();
      return ok({terms:terms.results.map(r=>r.term), sharedTerms:shared.results.map(r=>r.term), patterns:pats.results.map(r=>({label:r.pattern_label,regex:r.pattern_regex}))});
    }
    if (method==='PUT') {
      let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
      const terms = (Array.isArray(body.terms)?body.terms:[]).filter(t=>typeof t==='string'&&t.trim());
      // Drop (don't reject) invalid regexes: legacy rows round-trip through the client
      // verbatim, and a 400 here would silently brick every future save of the list.
      const patterns = (Array.isArray(body.patterns)?body.patterns:[])
        .filter(p=>p&&typeof p.label==='string'&&typeof p.regex==='string')
        .filter(p=>{ try { new RegExp(p.regex); return true } catch { return false } });
      await env.DB.batch([
        env.DB.prepare('DELETE FROM blocks WHERE user_id=?').bind(uid),
        env.DB.prepare('DELETE FROM hidden_patterns WHERE user_id=?').bind(uid),
        ...terms.map(t=>env.DB.prepare('INSERT OR IGNORE INTO blocks (user_id,term) VALUES(?,?)').bind(uid,t)),
        ...patterns.map(p=>env.DB.prepare('INSERT OR IGNORE INTO hidden_patterns (user_id,pattern_label,pattern_regex) VALUES(?,?,?)').bind(uid,p.label,p.regex)),
      ]);
      return ok({ok:true});
    }
  }

  // refine state
  if (path==='/api/refine') {
    if (method==='GET') {
      const rows = await env.DB.prepare('SELECT question_id FROM refine_state WHERE user_id=?').bind(uid).all();
      const state = {};
      rows.results.forEach(r=>{state[r.question_id]='resolved'});
      return ok(state);
    }
    if (method==='PUT') {
      const state = await request.json();
      for (const [id,status] of Object.entries(state)) {
        if (status==='resolved') await env.DB.prepare('INSERT OR IGNORE INTO refine_state (user_id,question_id) VALUES(?,?)').bind(uid,id).run();
      }
      return ok({ok:true});
    }
  }

  // preferred companies (shared defaults + per-user custom; a per-user tier=0
  // row is a tombstone that hides the shared seed of the same name)
  if (path==='/api/preferred-companies') {
    if (method==='GET') {
      const rows = await env.DB.prepare('SELECT user_id,name,tier,category FROM preferred_companies WHERE user_id=? OR user_id=?').bind('',uid).all();
      const merged = new Map();
      for (const r of rows.results) if (r.user_id==='') merged.set(r.name, r);
      for (const r of rows.results) if (r.user_id!=='') merged.set(r.name, r);
      const out = [...merged.values()].filter(r=>r.tier>0).map(({name,tier,category})=>({name,tier,category}));
      out.sort((a,b)=>a.tier-b.tier||a.name.localeCompare(b.name));
      return ok(out);
    }
    if (method==='POST') {
      let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
      const {name,tier=2,category='custom'} = body;
      if (!name) return err(400,'Missing name');
      await env.DB.prepare('INSERT OR REPLACE INTO preferred_companies (user_id,name,tier,category) VALUES(?,?,?,?)').bind(uid,name.trim(),parseInt(tier)||2,category||'custom').run();
      return ok({ok:true});
    }
  }
  // US sourcing layer — shared lookalike companies keyed by (city, name)
  if (path==='/api/us-companies/cities' && method==='GET') {
    const rows = await env.DB.prepare('SELECT city, COUNT(*) AS total, SUM(CASE WHEN tier=1 THEN 1 ELSE 0 END) AS tier1 FROM us_lookalike_companies GROUP BY city ORDER BY city').all();
    return ok(rows.results);
  }
  if (path==='/api/us-companies' && method==='GET') {
    const cities = (url.searchParams.get('cities')||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,20);
    if (!cities.length) return ok([]);
    const qs = cities.map(()=>'?').join(',');
    const rows = await env.DB.prepare(`SELECT city,name,tier,category FROM us_lookalike_companies WHERE city IN (${qs}) ORDER BY tier,name`).bind(...cities).all();
    return ok(rows.results);
  }

  // ── company DB (reframe: docs/specs/2026-07-02-company-db-reframe.md) ──
  // POST /api/companies/search {filters:[{field,op?,value,mode:'must'|'ranked',rank}],limit,offset}
  // must → WHERE; ranked → ORDER BY weighted match score (rank 0 = most important).
  if (path==='/api/companies/search' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const filters = (Array.isArray(body.filters)?body.filters:[]).slice(0,20);
    const limit = Math.min(parseInt(body.limit)||50, 5000);
    const offset = Math.max(parseInt(body.offset)||0, 0);
    const where = [], wParams = [];
    const ranked = [];
    for (const f of filters){
      const params = [];
      const expr = companyFilterExpr(f, params);
      if (!expr) continue;
      if (f.mode==='ranked') ranked.push({expr, params, rank: parseInt(f.rank)||0});
      else { where.push(expr); wParams.push(...params); }
    }
    ranked.sort((a,b)=>a.rank-b.rank);
    const scoreParts = ranked.map((r,i)=>`(CASE WHEN ${r.expr} THEN ${ranked.length-i} ELSE 0 END)`);
    const scoreExpr = scoreParts.length ? scoreParts.join('+') : '0';
    const scoreParams = ranked.flatMap(r=>r.params);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM companies ${whereSql}`).bind(...wParams).first();
    const rows = await env.DB.prepare(
      `SELECT id,name,domain,linkedin_url,hq_country,hq_city,region,industry,tech_stack,business_model,
              employees_min,employees_max,revenue_bucket,revenue_source,founded_year,total_raised_usd,last_round,
              (${scoreExpr}) AS match_score
       FROM companies ${whereSql} ORDER BY match_score DESC, name LIMIT ? OFFSET ?`
    ).bind(...scoreParams, ...wParams, limit, offset).all();
    return ok({total: total.n, companies: rows.results});
  }

  // Export every match as a Sales Nav account-list CSV (LinkedIn company URLs).
  if (path==='/api/companies/export' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const filters = (Array.isArray(body.filters)?body.filters:[]).slice(0,20);
    const where = ["linkedin_url IS NOT NULL"], wParams = [];
    for (const f of filters){
      if (f.mode==='ranked') continue;
      const params = [];
      const expr = companyFilterExpr(f, params);
      if (expr){ where.push(expr); wParams.push(...params); }
    }
    const rows = await env.DB.prepare(
      `SELECT name, linkedin_url FROM companies WHERE ${where.join(' AND ')} ORDER BY name LIMIT 20000`
    ).bind(...wParams).all();
    const csv = 'Company Name,LinkedIn URL\n' + rows.results.map(r=>`"${r.name.replace(/"/g,'""')}",${r.linkedin_url}`).join('\n');
    return new Response(csv, {headers:{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="companies.csv"'}});
  }

  // Saved filter set per (job, user): GET/POST /api/company-filters?job=ID
  if (path==='/api/company-filters') {
    const jobId = (url.searchParams.get('job')||'').slice(0,80);
    if (!jobId) return err(400,'Missing job');
    if (method==='GET') {
      const row = await env.DB.prepare('SELECT filters,company_ids,updated_at FROM job_company_filters WHERE job_id=? AND user_id=?').bind(jobId,uid).first();
      if (!row) return ok(null);
      let filters=[], companyIds=[]; try{filters=JSON.parse(row.filters)}catch{} try{companyIds=JSON.parse(row.company_ids)}catch{}
      return ok({filters, companyIds, updatedAt: row.updated_at});
    }
    if (method==='POST') {
      let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
      const filters = JSON.stringify((Array.isArray(body.filters)?body.filters:[]).slice(0,20));
      const companyIds = JSON.stringify((Array.isArray(body.companyIds)?body.companyIds:[]).slice(0,20000));
      await env.DB.prepare('INSERT OR REPLACE INTO job_company_filters (job_id,user_id,filters,company_ids,updated_at) VALUES(?,?,?,?,?)')
        .bind(jobId,uid,filters,companyIds,Date.now()).run();
      return ok({ok:true});
    }
  }

  // Stateless business-model classification (see classifyBusinessModel above).
  // POST {items:[{name,industry}]} (<=60) -> {results:[{i,business_model}]}. Callers persist.
  if (path==='/api/companies/classify-batch' && method==='POST') {
    let body; try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
    const items = (Array.isArray(body.items)?body.items:[]).slice(0,60)
      .map(it=>({name:String(it.name||'').slice(0,200), industry:String(it.industry||'').slice(0,100)}));
    if (!items.length) return err(400,'Missing items');
    try {
      const results = await classifyBusinessModel(env, items);
      return ok({results});
    } catch (e) {
      return err(502, String(e.message||e).slice(0,300));
    }
  }

  // Distinct values for filter dropdowns.
  if (path==='/api/companies/facets' && method==='GET') {
    const [countries, industries, models] = await Promise.all([
      env.DB.prepare('SELECT hq_country AS v, COUNT(*) AS n FROM companies WHERE hq_country IS NOT NULL GROUP BY hq_country ORDER BY n DESC LIMIT 60').all(),
      env.DB.prepare('SELECT industry AS v, COUNT(*) AS n FROM companies WHERE industry IS NOT NULL GROUP BY industry ORDER BY n DESC LIMIT 40').all(),
      env.DB.prepare('SELECT business_model AS v, COUNT(*) AS n FROM companies WHERE business_model IS NOT NULL GROUP BY business_model ORDER BY n DESC LIMIT 20').all(),
    ]);
    return ok({countries:countries.results, industries:industries.results, businessModels:models.results});
  }

  const prefDel = path.match(/^\/api\/preferred-companies\/(.+)$/);
  if (prefDel && method==='DELETE') {
    const name = decodeURIComponent(prefDel[1]);
    const shared = await env.DB.prepare("SELECT 1 AS x FROM preferred_companies WHERE user_id='' AND name=?").bind(name).first();
    if (shared) {
      await env.DB.prepare('INSERT OR REPLACE INTO preferred_companies (user_id,name,tier,category) VALUES(?,?,0,?)').bind(uid,name,'hidden').run();
    } else {
      await env.DB.prepare('DELETE FROM preferred_companies WHERE user_id=? AND name=?').bind(uid,name).run();
    }
    return ok({ok:true});
  }

  return err(404,'Not found');
}

// ── company filter → SQL (fields whitelisted; values always bound) ─
function companyFilterExpr(f, params){
  if (!f || typeof f!=='object') return null;
  const list = v => (Array.isArray(v)?v:[v]).map(x=>String(x).slice(0,80)).filter(Boolean).slice(0,30);
  switch(f.field){
    case 'region': {
      const vals = list(f.value).filter(v=>['fr','eu','us'].includes(v));
      if(!vals.length) return null;
      params.push(...vals); return `region IN (${vals.map(()=>'?').join(',')})`;
    }
    case 'country': {
      const vals = list(f.value); if(!vals.length) return null;
      params.push(...vals.map(v=>v.toLowerCase())); return `LOWER(hq_country) IN (${vals.map(()=>'?').join(',')})`;
    }
    case 'industry': {
      const vals = list(f.value); if(!vals.length) return null;
      params.push(...vals.map(v=>v.toLowerCase())); return `LOWER(industry) IN (${vals.map(()=>'?').join(',')})`;
    }
    case 'business_model': {
      const vals = list(f.value); if(!vals.length) return null;
      params.push(...vals); return `business_model IN (${vals.map(()=>'?').join(',')})`;
    }
    case 'employees': {  // {min,max} — overlap with the company's range
      const min = parseInt(f.value&&f.value.min), max = parseInt(f.value&&f.value.max);
      const parts = [];
      if (Number.isFinite(min)){ parts.push('employees_max>=?'); params.push(min); }
      if (Number.isFinite(max)){ parts.push('employees_min<=?'); params.push(max); }
      return parts.length ? `(${parts.join(' AND ')})` : null;
    }
    case 'founded_after': {
      const y = parseInt(f.value); if(!Number.isFinite(y)) return null;
      params.push(y); return 'founded_year>=?';
    }
    case 'raised': {  // {min,max} USD
      const min = parseInt(f.value&&f.value.min), max = parseInt(f.value&&f.value.max);
      const parts = [];
      if (Number.isFinite(min)){ parts.push('total_raised_usd>=?'); params.push(min); }
      if (Number.isFinite(max)){ parts.push('total_raised_usd<=?'); params.push(max); }
      return parts.length ? `(${parts.join(' AND ')})` : null;
    }
    case 'revenue_bucket': {
      const vals = list(f.value); if(!vals.length) return null;
      params.push(...vals); return `revenue_bucket IN (${vals.map(()=>'?').join(',')})`;
    }
    case 'stack': {  // any-of match inside the JSON array text
      const vals = list(f.value); if(!vals.length) return null;
      const parts = vals.map(()=>'tech_stack LIKE ?');
      params.push(...vals.map(v=>`%"${v.toLowerCase()}"%`));
      return `(${parts.join(' OR ')})`;
    }
    case 'name': {
      const v = String(f.value||'').slice(0,80); if(!v) return null;
      params.push(`%${kbNormCompany(v)}%`); return 'name_norm LIKE ?';
    }
    default: return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────
const ok  = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
const err = (s,m) => new Response(JSON.stringify({error:m}), {status:s, headers:{'Content-Type':'application/json'}});

// ── login page (inline) ───────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sourcing Scorer — Sign in</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{background:#F1F4F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;align-items:center;justify-content:center}
.w{width:360px;padding:24px}
.eye{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#1D4ED8;margin-bottom:10px}
h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px}
.sub{font-size:14px;color:#475569;margin-bottom:28px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
input{display:block;width:100%;font:inherit;font-size:14px;padding:9px 12px;border:1.5px solid #E2E8F0;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#1D4ED8}
button{width:100%;font:inherit;font-size:14px;font-weight:600;background:#1D4ED8;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;margin-top:4px}
button:hover{background:#1e40af}
.error{font-size:13px;color:#DC2626;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="w">
  <div class="eye">GitGuardian Recruiting</div>
  <h1>Sourcing Scorer</h1>
  <p class="sub">Sign in to access your session</p>
  <div class="card">
    <form id="f">
      <input name="username" type="text" placeholder="Username" required autocomplete="username" autofocus>
      <input name="password" type="password" placeholder="Password" required autocomplete="current-password">
      <button type="submit">Sign in</button>
      <div class="error" id="er"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=e.target.querySelector('button[type=submit]');
  btn.disabled=true;
  const fd=new FormData(e.target);
  const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fd.get('username'),password:fd.get('password')})});
  if(res.ok)location.href='/';
  else{const d=await res.json().catch(()=>({}));const er=document.getElementById('er');er.textContent=d.error||'Invalid username or password';er.style.display='block';btn.disabled=false;}
});
</script>
</body>
</html>`;

// ── main entry ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname==='/api/auth/login' && request.method==='POST') return handleLogin(request, env);
    if (url.pathname==='/api/auth/logout') return await handleLogout(request, env);

    const session = await getSession(request, env);

    if (!session) {
      if (url.pathname.startsWith('/api/')) return err(401,'Unauthorized');
      return new Response(LOGIN_HTML, {headers:{'Content-Type':'text/html;charset=utf-8'}});
    }

    if (url.pathname.startsWith('/api/')) return handleAPI(request, url, session, env);
    const assetRes = await env.ASSETS.fetch(request);
    const h = new Headers(assetRes.headers);
    h.set('Cache-Control', 'private, no-store');
    return new Response(assetRes.body, {status:assetRes.status, statusText:assetRes.statusText, headers:h});
  },
};
