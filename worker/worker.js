// Cloudflare Worker: 452번 반포역(22017) -> 중앙대학교(20194)
// 환경변수(Secret) BUS_API_KEY 에 공공데이터포털 인증키를 넣어요. 없으면 샘플 모드.
// 환경변수 ALLOW_ORIGIN 에 https://yeonn10.github.io 를 넣으면 그 주소에서만 호출 가능.

const CFG = { route: '452', fromArs: '22017', toArs: '20194' };
let KEY = '';
let MOCK = true;
const BASE = 'http://ws.bus.go.kr/api/rest';
const DEFAULT_SEG = 90; // 구간(정류장 간) 데이터 없을 때 기본 초

function parseItems(xml) {
  const items = [];
  const re = /<itemList>([\s\S]*?)<\/itemList>/g;
  let m;
  while ((m = re.exec(xml))) {
    const o = {};
    const fre = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fre.exec(m[1]))) o[f[1]] = f[2].trim();
    items.push(o);
  }
  return items;
}
async function seoul(p, params) {
  // Decoding 키(특수문자 포함)도, 이미 인코딩된 키(%포함)도 모두 처리
  const k = KEY.includes('%') ? KEY : encodeURIComponent(KEY);
  const url = `${BASE}${p}?serviceKey=${k}&${new URLSearchParams(params)}`;
  const xml = await (await fetch(url)).text();
  const code = (xml.match(/<headerCd>(\d+)<\/headerCd>/) || [])[1];
  if (code && code !== '0') throw new Error(`서울시 API 오류(${code}): ${(xml.match(/<headerMsg>([\s\S]*?)<\/headerMsg>/) || [])[1]}`);
  if (!code && !/<itemList>/.test(xml)) throw new Error('API 응답 이상(키 확인): ' + xml.slice(0, 150));
  return parseItems(xml);
}
const msgToSec = (m) => {
  if (!m) return null;
  const a = m.match(/(\d+)분/), b = m.match(/(\d+)초/);
  return a || b ? (a ? +a[1] * 60 : 0) + (b ? +b[1] : 0) : null;
};
const secOf = (it, n) => { const e = parseInt(it['exps' + n], 10); return e > 0 ? e : msgToSec(it['arrmsg' + n]); };

// ---------- 샘플 데이터 ----------
function mock() {
  const N = 40;
  const stops = [];
  for (let i = 1; i <= N; i++) stops.push({ seq: String(i), stNm: i === 20 ? '반포역' : i === 33 ? '중앙대학교' : `정류장${i}`, arsId: i === 20 ? '22017' : i === 33 ? '20194' : String(10000 + i) });
  const seg = (i) => 70 + ((i * 37) % 50);
  // 버스 5대: 위치(구간순번) 와 진행률
  const bus = [{ id: 'A', ord: 19, f: 0.3 }, { id: 'B', ord: 15, f: 0.6 }, { id: 'C', ord: 10, f: 0.1 }, { id: 'D', ord: 5, f: 0.5 }, { id: 'E', ord: 1, f: 0.2 }];
  const etaTo = (b, target) => { let t = (1 - b.f) * seg(b.ord + 1); for (let k = b.ord + 2; k <= target; k++) t += seg(k); return t; };
  const arr = stops.map((s) => {
    const o = { staOrd: s.seq, stNm: s.stNm, arsId: s.arsId, term: '9' };
    bus.filter((b) => b.ord + 1 <= +s.seq).slice(-2).reverse().forEach((b, k) => { o['vehId' + (k + 1)] = b.id; o['exps' + (k + 1)] = String(Math.round(etaTo(b, +s.seq))); });
    return o;
  });
  const pos = bus.map((b) => ({ vehId: b.id, plainNo: '서울74사' + (1000 + b.ord), sectOrd: String(b.ord), sectDist: String(b.f * 500), fullSectDist: '500', isrunyn: '1' }));
  return { stops, arr, pos };
}

// ---------- 핵심 계산 ----------
let meta = null; // 노선ID / 정류장 순번 캐시
async function getMeta() {
  if (meta) return meta;
  if (MOCK) {
    const m = mock();
    const f = m.stops.find((s) => s.arsId === CFG.fromArs), t = m.stops.find((s) => s.arsId === CFG.toArs);
    return (meta = { routeId: 'MOCK', stops: m.stops, fromOrd: +f.seq, toOrd: +t.seq });
  }
  const routes = await seoul('/busRouteInfo/getBusRouteList', { strSrch: CFG.route });
  const r = routes.find((x) => x.busRouteNm === CFG.route);
  if (!r) throw new Error(`${CFG.route}번 노선을 찾지 못했어요`);
  const st = (await seoul('/busRouteInfo/getStaionByRoute', { busRouteId: r.busRouteId })).map((i) => ({ seq: i.seq, stNm: i.stationNm, arsId: i.arsId }));
  const f = st.find((s) => s.arsId === CFG.fromArs), t = st.find((s) => s.arsId === CFG.toArs);
  if (!f || !t) throw new Error('정류장 번호(arsId)가 이 노선에서 안 보여요');
  if (+t.seq <= +f.seq) throw new Error('도착 정류장이 출발 정류장보다 앞이에요 (노선 방향 확인)');
  return (meta = { routeId: r.busRouteId, stops: st, fromOrd: +f.seq, toOrd: +t.seq });
}

// 실시간 도착정보로 "정류장 사이 걸리는 시간(초)" 표 만들기
function buildSeg(arr) {
  const byVeh = {};
  for (const it of arr) for (const n of [1, 2]) {
    const v = it['vehId' + n], s = secOf(it, n);
    if (v && s != null) (byVeh[v] = byVeh[v] || []).push({ ord: +it.staOrd, sec: s });
  }
  const samples = {};
  for (const v in byVeh) {
    const a = byVeh[v].sort((x, y) => x.ord - y.ord);
    for (let i = 1; i < a.length; i++) {
      const gap = a[i].ord - a[i - 1].ord, d = a[i].sec - a[i - 1].sec;
      if (gap > 0 && d > 0) for (let k = a[i - 1].ord + 1; k <= a[i].ord; k++) (samples[k] = samples[k] || []).push(d / gap);
    }
  }
  const all = Object.values(samples).flat().sort((a, b) => a - b);
  const med = all.length ? all[Math.floor(all.length / 2)] : DEFAULT_SEG;
  const seg = (k) => (samples[k] ? samples[k].reduce((a, b) => a + b, 0) / samples[k].length : med);
  return { seg, med, byVeh };
}

async function compute() {
  const m = await getMeta();
  const arr = MOCK ? mock().arr : await seoul('/arrive/getArrInfoByRouteAll', { busRouteId: m.routeId });
  const pos = MOCK ? mock().pos : await seoul('/buspos/getBusPosByRtid', { busRouteId: m.routeId });
  const { seg, byVeh } = buildSeg(arr);
  const now = Date.now();
  const sumSeg = (a, b) => { let t = 0; for (let k = a; k <= b; k++) t += seg(k); return t; }; // 정류장 a..b 구간(각 k는 k-1->k)
  const fromItem = arr.find((i) => +i.staOrd === m.fromOrd);
  const term = parseInt(fromItem && fromItem.term, 10) || 0;

  // 실시간(공식) 도착예측이 있는 차량
  const realFrom = {}, realTo = {};
  for (const v in byVeh) for (const e of byVeh[v]) { if (e.ord === m.fromOrd) realFrom[v] = e.sec; if (e.ord === m.toOrd) realTo[v] = e.sec; }

  // 위치 기반 예측: 버스가 sectOrd 다음 정류장으로 가는 중이라고 가정(off=0) / 직전 정류장으로 가는 중(off=-1) 중
  // 공식 예측과 더 잘 맞는 쪽을 자동 선택
  const predict = (b, off) => {
    const o = +b.sectOrd, f = Math.min(1, (+b.sectDist || 0) / (+b.fullSectDist || 1));
    const next = o + 1 + off;
    if (next > m.fromOrd) return null;
    return (1 - f) * seg(next) + (next < m.fromOrd ? sumSeg(next + 1, m.fromOrd) : 0);
  };
  const score = (off) => {
    let err = 0, n = 0;
    for (const b of pos) if (realFrom[b.vehId] != null) { const p = predict(b, off); if (p != null) { err += Math.abs(p - realFrom[b.vehId]); n++; } }
    return n ? err / n : Infinity;
  };
  const e0 = score(0), e1 = score(-1);
  const off = e1 < e0 ? -1 : 0;
  const calibErr = Math.min(e0, e1);

  const nameOf = (ord) => (m.stops.find((s) => +s.seq === ord) || {}).stNm || '';
  const buses = [];
  const seen = new Set();
  for (const b of pos) {
    if (b.isrunyn === '0') continue;
    const o = +b.sectOrd;
    const real = realFrom[b.vehId];
    const p = predict(b, off);
    const etaSec = real != null ? real : p;
    if (etaSec == null || etaSec > 90 * 60) continue;
    seen.add(b.vehId);
    const rideSec = realTo[b.vehId] != null && real != null && realTo[b.vehId] > real ? realTo[b.vehId] - real : sumSeg(m.fromOrd + 1, m.toOrd);
    buses.push({ vehId: b.vehId, plate: b.plainNo, source: real != null ? 'official' : 'position', etaSec, rideSec,
      rideSource: realTo[b.vehId] != null && real != null ? 'official' : 'segments',
      stopsAway: m.fromOrd - (o + 1 + off) + 1, where: nameOf(o + 1 + off) });
  }
  // 위치정보엔 없는데 공식 예측에는 있는 차량도 추가
  for (const v in realFrom) if (!seen.has(v)) buses.push({ vehId: v, plate: '', source: 'official', etaSec: realFrom[v], rideSec: realTo[v] > realFrom[v] ? realTo[v] - realFrom[v] : sumSeg(m.fromOrd + 1, m.toOrd), rideSource: realTo[v] ? 'official' : 'segments', stopsAway: null, where: '' });
  buses.sort((a, b) => a.etaSec - b.etaSec);
  return {
    now, mock: MOCK, term, fromName: nameOf(m.fromOrd), toName: nameOf(m.toOrd), route: CFG.route,
    calibErrSec: isFinite(calibErr) ? Math.round(calibErr) : null, off,
    buses: buses.map((b) => ({ ...b, busAt: now + Math.round(b.etaSec) * 1000, rideMin: b.rideSec / 60 })),
  };
}


export default {
  async fetch(request, env) {
    KEY = env.BUS_API_KEY || '';
    MOCK = !KEY;
    const origin = env.ALLOW_ORIGIN || '*';
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/api/arrivals') return new Response(JSON.stringify({ ok: true, hint: '/api/arrivals' }), { headers });
      // 호출 횟수 절약: 결과를 45초 동안 공유(여러 번 새로고침해도 API는 한 번만 호출)
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const ck = new Request('https://cache.local/arrivals-452');
      if (cache && !MOCK) {
        const hit = await cache.match(ck);
        if (hit) return new Response(hit.body, { headers });
      }
      const body = JSON.stringify(await compute());
      if (cache && !MOCK) await cache.put(ck, new Response(body, { headers: { 'Cache-Control': 'max-age=45' } }));
      return new Response(body, { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  },
};
