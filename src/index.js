const SESSION_NAME = 'ss_session';
const SESSION_MS = 7 * 86400_000;

const DEFAULT_JOBS = [
  {id:'hoa',title:'Head of Accounting, tax and consolidation'},
  {id:'swe',title:'Senior Software Engineer'},
  {id:'ae',title:'Enterprise Account Executive'},
  {id:'bdr',title:'Business Development Representative'},
  {id:'csm',title:'Customer Success Manager'},
  {id:'sec',title:'Senior Security Engineer'},
  {id:'pm',title:'Product Manager'},
];

// ── password ──────────────────────────────────────────────────────
async function hashPassword(plain, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(plain), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name:'PBKDF2', salt:enc.encode(salt), iterations:100_000, hash:'SHA-256'},
    key, 256
  );
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
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
  return `${SESSION_NAME}=${token||''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:SESSION_MS/1000}`;
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
    await env.DB.prepare('INSERT OR IGNORE INTO users (id,name,password_hash,password_salt) VALUES(?,?,?,?)')
      .bind(u.id, u.name, hash, salt).run();
  }
}

// ── auth endpoints ────────────────────────────────────────────────
async function handleLogin(request, env) {
  await seedUsersIfEmpty(env);
  let body;
  try { body = await request.json(); } catch { return err(400,'Invalid JSON'); }
  const user = await env.DB.prepare('SELECT id,name,password_hash,password_salt FROM users WHERE id=?')
    .bind((body.username||'').toLowerCase().trim()).first();
  if (!user) return err(401,'Invalid credentials');
  const ok = (await hashPassword(body.password||'', user.password_salt)) === user.password_hash;
  if (!ok) return err(401,'Invalid credentials');
  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES(?,?,?)').bind(token,user.id,Date.now()).run();
  return new Response(JSON.stringify({ok:true,user:{id:user.id,name:user.name}}), {
    headers:{'Content-Type':'application/json','Set-Cookie':setCookie(token,false)},
  });
}

function handleLogout(request, env) {
  const token = getToken(request);
  if (token) env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
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
      return ok(row ? {hotThreshold:row.hot_threshold, filterCFO:!!row.filter_cfo, filterInterim:!!row.filter_interim, filterExpertComptable:!!row.filter_expert_comptable}
                    : {hotThreshold:65, filterCFO:true, filterInterim:true, filterExpertComptable:true});
    }
    if (method==='PUT') {
      const s = await request.json();
      await env.DB.prepare('INSERT OR REPLACE INTO user_settings (user_id,hot_threshold,filter_cfo,filter_interim,filter_expert_comptable) VALUES(?,?,?,?,?)')
        .bind(uid, s.hotThreshold??65, s.filterCFO?1:0, s.filterInterim?1:0, s.filterExpertComptable?1:0).run();
      return ok({ok:true});
    }
  }

  // jobs
  if (path==='/api/jobs') {
    if (method==='GET') {
      const rows = await env.DB.prepare('SELECT id,title FROM jobs WHERE user_id=? ORDER BY sort_order').bind(uid).all();
      return ok(rows.results.length ? rows.results : DEFAULT_JOBS);
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
    await env.DB.prepare('DELETE FROM jobs WHERE user_id=? AND id=?').bind(uid,jobDel[1]).run();
    return ok({ok:true});
  }

  // blocks (terms + hidden patterns combined)
  if (path==='/api/blocks') {
    if (method==='GET') {
      const terms = await env.DB.prepare('SELECT term FROM blocks WHERE user_id=?').bind(uid).all();
      const pats  = await env.DB.prepare('SELECT pattern_label,pattern_regex FROM hidden_patterns WHERE user_id=?').bind(uid).all();
      return ok({terms:terms.results.map(r=>r.term), patterns:pats.results.map(r=>({label:r.pattern_label,regex:r.pattern_regex}))});
    }
    if (method==='PUT') {
      const {terms=[],patterns=[]} = await request.json();
      await env.DB.prepare('DELETE FROM blocks WHERE user_id=?').bind(uid).run();
      await env.DB.prepare('DELETE FROM hidden_patterns WHERE user_id=?').bind(uid).run();
      for (const t of terms) await env.DB.prepare('INSERT OR IGNORE INTO blocks (user_id,term) VALUES(?,?)').bind(uid,t).run();
      for (const p of patterns) await env.DB.prepare('INSERT OR IGNORE INTO hidden_patterns (user_id,pattern_label,pattern_regex) VALUES(?,?,?)').bind(uid,p.label,p.regex).run();
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

  return err(404,'Not found');
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
  const fd=new FormData(e.target);
  const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fd.get('username'),password:fd.get('password')})});
  if(res.ok)location.href='/';
  else{const er=document.getElementById('er');er.textContent='Invalid username or password';er.style.display='block';}
});
</script>
</body>
</html>`;

// ── main entry ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname==='/api/auth/login' && request.method==='POST') return handleLogin(request, env);
    if (url.pathname==='/api/auth/logout') return handleLogout(request, env);

    const session = await getSession(request, env);

    if (!session) {
      if (url.pathname.startsWith('/api/')) return err(401,'Unauthorized');
      return new Response(LOGIN_HTML, {headers:{'Content-Type':'text/html;charset=utf-8'}});
    }

    if (url.pathname.startsWith('/api/')) return handleAPI(request, url, session, env);
    return env.ASSETS.fetch(request);
  },
};
