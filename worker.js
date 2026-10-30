// Cloudflare Worker：保管 GitHub token，所有資料存在私有 repo 的 data.json
// 需要的環境變數：GH_TOKEN（secret）、GH_REPO（如 "me/dance-data"）、ADMIN_PASSWORD（secret）
const PLANS = {
  single: { label: '單堂課程', total: 1, days: [5, 0] },
  fri4: { label: '四堂週五優惠課程', total: 4, days: [5] },
  sun4: { label: '四堂週日優惠課程', total: 4, days: [0] },
  fri8: { label: '八堂週五優惠課程', total: 8, days: [5] },
  sun8: { label: '八堂週日優惠課程', total: 8, days: [0] },
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0/O/1/I
const FILE = 'data.json';

const b64e = (s) => { let t = ''; new TextEncoder().encode(s).forEach((x) => (t += String.fromCharCode(x))); return btoa(t); };
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function gh(env, method, body) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${FILE}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'dance-signup',
      Accept: 'application/vnd.github+json',
    },
    body: body && JSON.stringify(body),
  });
}
async function load(env) {
  const r = await gh(env, 'GET');
  if (r.status === 404) return { data: { members: [] }, sha: undefined };
  if (!r.ok) throw new Error('讀取資料失敗');
  const j = await r.json();
  return { data: JSON.parse(b64d(j.content)), sha: j.sha };
}
// 讀 → 修改 → 寫回；若同時有人寫入（409/422）就重試
async function mutate(env, fn) {
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await load(env);
    const out = fn(data);
    const r = await gh(env, 'PUT', { message: 'update', content: b64e(JSON.stringify(data, null, 1)), sha });
    if (r.ok) return out;
    if (r.status !== 409 && r.status !== 422) throw new Error('寫入資料失敗');
  }
  throw new Error('目前人數較多，請再試一次');
}

// 以台灣時間計算今天起 60 天內的週五、週日
function upcoming(days) {
  const base = new Date(Date.now() + 8 * 3600e3);
  const out = [];
  for (let i = 0; i <= 60; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const remaining = (m) => PLANS[m.plan].total - m.dates.length;
function view(m) {
  const p = PLANS[m.plan];
  const left = remaining(m);
  return {
    name: m.name,
    plan: p.label,
    total: p.total,
    remaining: left,
    booked: [...m.dates].sort(),
    options: left > 0 ? upcoming(p.days).filter((d) => !m.dates.includes(d)) : [],
  };
}
const findMember = (data, code) => data.members.find((m) => m.code === String(code || '').trim().toUpperCase());

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    try {
      const b = await req.json();
      const isAdmin = b.password && b.password === env.ADMIN_PASSWORD;

      if (b.action === 'login') {
        const { data } = await load(env);
        const m = findMember(data, b.code);
        return m ? reply({ ok: true, info: view(m) }) : reply({ ok: false, error: '找不到這組帳號' });
      }

      if (b.action === 'book') {
        const info = await mutate(env, (data) => {
          const m = findMember(data, b.code);
          if (!m) throw new Error('找不到這組帳號');
          const dates = [...new Set(Array.isArray(b.dates) ? b.dates : [])];
          const allowed = upcoming(PLANS[m.plan].days);
          if (!dates.length) throw new Error('請至少選一堂');
          if (dates.length > remaining(m)) throw new Error('選的堂數超過剩餘堂數');
          if (dates.some((d) => !allowed.includes(d) || m.dates.includes(d))) throw new Error('選了不可預約的日期');
          m.dates.push(...dates);
          return view(m);
        });
        return reply({ ok: true, info });
      }

      if (!isAdmin) return reply({ ok: false, error: '管理員密碼錯誤' }, 401);

      if (b.action === 'admin_list') {
        const { data } = await load(env);
        return reply({
          ok: true,
          members: data.members.map((m) => ({ code: m.code, name: m.name, line: m.line, plan: PLANS[m.plan].label, remaining: remaining(m), booked: [...m.dates].sort() })),
        });
      }

      if (b.action === 'admin_create') {
        const name = String(b.name || '').trim();
        if (!name || !PLANS[b.plan]) return reply({ ok: false, error: '資料不完整' });
        const code = await mutate(env, (data) => {
          let c;
          do {
            c = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => ALPHABET[x % 32]).join('');
          } while (data.members.some((m) => m.code === c));
          data.members.push({ code: c, name, line: String(b.line || '').trim(), plan: b.plan, dates: [], created: new Date().toISOString() });
          return c;
        });
        return reply({ ok: true, code });
      }
      return reply({ ok: false, error: '未知的操作' }, 400);
    } catch (e) {
      return reply({ ok: false, error: e.message || '發生錯誤' }, 500);
    }
  },
};
