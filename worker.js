// Cloudflare Worker v2。環境變數：GH_TOKEN（secret）、GH_REPO、ADMIN_PASSWORD（secret）
const PLANS = {
  single: { label: '單堂課程', total: 1, days: [5, 0] },
  fri4: { label: '四堂週五優惠課程', total: 4, days: [5] },
  sun4: { label: '四堂週日優惠課程', total: 4, days: [0] },
  fri8: { label: '八堂週五優惠課程', total: 8, days: [5] },
  sun8: { label: '八堂週日優惠課程', total: 8, days: [0] },
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FILE = 'data.json';

const b64e = (s) => { let t = ''; new TextEncoder().encode(s).forEach((x) => (t += String.fromCharCode(x))); return btoa(t); };
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function gh(env, method, body) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${FILE}`, {
    method,
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, 'User-Agent': 'dance-signup', Accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
  });
}
// 舊格式（單一 plan + dates）自動轉成新格式（packs + bookings）
function norm(d) {
  d.settings ??= { cancelHours: 0 };
  d.cancelled ??= {};
  d.members.forEach((m) => {
    if (!m.packs) {
      m.packs = [{ id: 'p0', plan: m.plan, total: PLANS[m.plan].total }];
      m.bookings = (m.dates || []).map((date) => ({ date, packId: 'p0', status: 'booked' }));
      delete m.plan; delete m.dates;
    }
  });
  return d;
}
async function load(env) {
  const r = await gh(env, 'GET');
  if (r.status === 404) return { data: norm({ members: [] }), sha: undefined };
  if (!r.ok) throw new Error('讀取資料失敗 ' + r.status);
  const j = await r.json();
  return { data: norm(JSON.parse(b64d(j.content))), sha: j.sha };
}
async function mutate(env, fn) {
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await load(env);
    const out = fn(data);
    const r = await gh(env, 'PUT', { message: 'update', content: b64e(JSON.stringify(data, null, 1)), sha });
    if (r.ok) return out;
    if (r.status !== 409 && r.status !== 422) throw new Error('寫入資料失敗 ' + r.status);
  }
  throw new Error('目前人數較多，請再試一次');
}

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const dayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
function upcoming(days) {
  const b = new Date(Date.now() + 8 * 3600e3), out = [];
  for (let i = 0; i <= 60; i++) {
    const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + i));
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const active = (b) => b.status !== 'cancelled';
const left = (m, p) => p.total - m.bookings.filter((b) => b.packId === p.id && active(b)).length;
// 取消時限：以上課日台灣時間 00:00 為基準
const canCancel = (b, data) => active(b) && b.date >= today() && Date.parse(b.date + 'T00:00:00+08:00') - Date.now() >= data.settings.cancelHours * 3600e3;

function view(m, data) {
  const t = today();
  const caps = { fri: 0, sun: 0, flex: 0 };
  m.packs.forEach((p) => {
    const r = left(m, p);
    if (p.plan === 'single') caps.flex += r; else if (PLANS[p.plan].days[0] === 5) caps.fri += r; else caps.sun += r;
  });
  const have = new Set(m.bookings.filter(active).map((b) => b.date));
  const options = upcoming([5, 0]).filter((d) => !have.has(d) && !data.cancelled[d] && (dayOf(d) === 5 ? caps.fri : caps.sun) + caps.flex > 0);
  return {
    name: m.name,
    packs: m.packs.map((p) => ({ label: PLANS[p.plan].label, remaining: left(m, p) })),
    caps, options, remaining: caps.fri + caps.sun + caps.flex, cancelHours: data.settings.cancelHours,
    history: [...m.bookings].sort((a, b) => (a.date < b.date ? 1 : -1)).map((b) => ({
      date: b.date,
      plan: PLANS[m.packs.find((p) => p.id === b.packId).plan].label,
      status: b.status === 'cancelled' ? 'cancel-' + (b.by || 'admin') : b.date < t ? 'done' : 'booked',
      canCancel: canCancel(b, data),
    })),
  };
}
// 配堂：優先扣優惠課程，其次單堂課程
function allocate(m, dates) {
  const rem = new Map(m.packs.map((p) => [p.id, left(m, p)]));
  const order = [...m.packs].sort((a, b) => (a.plan === 'single') - (b.plan === 'single'));
  return dates.map((d) => {
    const p = order.find((p) => PLANS[p.plan].days.includes(dayOf(d)) && rem.get(p.id) > 0);
    if (!p) throw new Error('選的堂數超過剩餘堂數，或不符合課程規則');
    rem.set(p.id, rem.get(p.id) - 1);
    return { date: d, packId: p.id, status: 'booked', at: new Date().toISOString() };
  });
}
const findMember = (data, code) => data.members.find((m) => m.code === String(code || '').trim().toUpperCase());

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    try {
      const b = await req.json();

      if (b.action === 'login') {
        const { data } = await load(env);
        const m = findMember(data, b.code);
        return m ? reply({ ok: true, info: view(m, data) }) : reply({ ok: false, error: '找不到這組帳號' });
      }
      if (b.action === 'book') {
        const info = await mutate(env, (data) => {
          const m = findMember(data, b.code);
          if (!m) throw new Error('找不到這組帳號');
          const dates = [...new Set(Array.isArray(b.dates) ? b.dates : [])].sort();
          if (!dates.length) throw new Error('請至少選一堂');
          const opts = view(m, data).options;
          if (dates.some((d) => !opts.includes(d))) throw new Error('選了不可預約的日期');
          m.bookings.push(...allocate(m, dates));
          return view(m, data);
        });
        return reply({ ok: true, info });
      }
      if (b.action === 'cancel') {
        const info = await mutate(env, (data) => {
          const m = findMember(data, b.code);
          if (!m) throw new Error('找不到這組帳號');
          const bk = m.bookings.find((x) => x.date === b.date && active(x));
          if (!bk) throw new Error('找不到這堂課');
          if (!canCancel(bk, data)) throw new Error(`已超過取消時限（需在上課日前 ${data.settings.cancelHours} 小時取消），請聯絡老師`);
          bk.status = 'cancelled'; bk.by = 'member'; bk.cancelledAt = new Date().toISOString();
          return view(m, data);
        });
        return reply({ ok: true, info });
      }

      if (!b.password || b.password !== env.ADMIN_PASSWORD) return reply({ ok: false, error: '管理員密碼錯誤' }, 401);

      if (b.action === 'admin_list') {
        const { data } = await load(env);
        const dates = new Set([...upcoming([5, 0]), ...Object.keys(data.cancelled)]);
        data.members.forEach((m) => m.bookings.forEach((x) => dates.add(x.date)));
        const stats = [...dates].sort().map((d) => {
          const names = data.members.filter((m) => m.bookings.some((x) => x.date === d && active(x))).map((m) => m.name);
          return { date: d, count: names.length, names, cancelled: !!data.cancelled[d], past: d < today() };
        });
        return reply({
          ok: true, settings: data.settings, stats,
          members: data.members.map((m) => ({
            code: m.code, name: m.name, line: m.line,
            packs: m.packs.map((p) => ({ label: PLANS[p.plan].label, remaining: left(m, p) })),
            remaining: m.packs.reduce((n, p) => n + left(m, p), 0),
            booked: m.bookings.filter(active).map((x) => x.date).sort(),
          })),
        });
      }
      if (b.action === 'admin_create') {
        const name = String(b.name || '').trim();
        if (!name || !PLANS[b.plan]) return reply({ ok: false, error: '資料不完整' });
        const code = await mutate(env, (data) => {
          let c;
          do { c = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => ALPHABET[x % 32]).join(''); } while (data.members.some((m) => m.code === c));
          data.members.push({ code: c, name, line: String(b.line || '').trim(), packs: [{ id: 'p0', plan: b.plan, total: PLANS[b.plan].total }], bookings: [], created: new Date().toISOString() });
          return c;
        });
        return reply({ ok: true, code });
      }
      if (b.action === 'admin_add_pack') {
        if (!PLANS[b.plan]) return reply({ ok: false, error: '課程選項錯誤' });
        await mutate(env, (data) => {
          const m = findMember(data, b.code);
          if (!m) throw new Error('找不到這位會員');
          m.packs.push({ id: 'p' + Date.now().toString(36), plan: b.plan, total: PLANS[b.plan].total, added: new Date().toISOString() });
        });
        return reply({ ok: true });
      }
      if (b.action === 'admin_cancel_date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || b.date < today()) return reply({ ok: false, error: '只能取消今天以後的日期' });
        const n = await mutate(env, (data) => {
          data.cancelled[b.date] = { at: new Date().toISOString() };
          let c = 0;
          data.members.forEach((m) => m.bookings.forEach((x) => {
            if (x.date === b.date && active(x)) { x.status = 'cancelled'; x.by = 'admin'; x.cancelledAt = new Date().toISOString(); c++; }
          }));
          return c;
        });
        return reply({ ok: true, refunded: n });
      }
      if (b.action === 'admin_set_hours') {
        const h = Number(b.hours);
        if (!(h >= 0)) return reply({ ok: false, error: '請輸入 0 以上的數字' });
        await mutate(env, (data) => { data.settings.cancelHours = h; });
        return reply({ ok: true });
      }
      return reply({ ok: false, error: '未知的操作' }, 400);
    } catch (e) {
      return reply({ ok: false, error: e.message || '發生錯誤' }, 500);
    }
  },
};
