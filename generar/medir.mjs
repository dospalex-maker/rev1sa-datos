/**
 * rev1sa-datos · Medir (solo informe, no publica nada): cuánto cambian los horarios de Galicia de un día a otro y cuánto
 * pesaría guardar 1 mes como «días tipo» (laborable, sábado, domingo + 2 festivos) frente a 7 / 30 días reales.
 * Uso: node --max-old-space-size=6144 generar/medir.mjs
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const TMP = '/tmp/medir', CLAVE_NAP = process.env.NAP_API_KEY || '';
const CAJA = [41.75, -9.4, 43.9, -6.65]; // Galicia
const enGalicia = (la, lo) => la >= CAJA[0] && la <= CAJA[2] && lo >= CAJA[1] && lo <= CAJA[3];
const fuentes = JSON.parse(readFileSync('generar/fuentes.json', 'utf8')).fuentes
  .filter((f) => f.c === 'Galicia' || /Galicia/.test(f.z ?? '') || f.z === '*' || f.c === 'Estatales');
const DIAS = 35;
const hoy = new Date(); const d0 = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate(), 12));
const FECHAS = Array.from({ length: DIAS }, (_, i) => new Date(d0.getTime() + i * 86_400_000));
const iso = (d) => d.toISOString().slice(0, 10);
const SEM = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NOMBRE = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// Festivos nacionales/Galicia en el periodo (para clasificar).
const FESTIVOS = new Set(['2026-12-08', '2026-12-25', '2027-01-01', '2027-01-06']);
const clase = (d) => (FESTIVOS.has(iso(d)) ? 'fest' : d.getUTCDay() === 0 ? 'dom' : d.getUTCDay() === 6 ? 'sab' : 'lab');

function campos(l) {
  if (!l.includes('"')) return l.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
}
async function* filas(ruta) {
  if (!existsSync(ruta)) return; let cab = null;
  for await (const l of createInterface({ input: createReadStream(ruta, 'utf8'), crlfDelay: Infinity })) {
    if (!l.trim()) continue;
    if (!cab) { cab = campos(l.replace(/^﻿/, '')).map((x) => x.trim()); continue; }
    const c = campos(l), o = {}; for (let i = 0; i < cab.length; i++) o[cab[i]] = (c[i] ?? '').trim(); yield o;
  }
}
async function todas(r) { const a = []; for await (const f of filas(r)) a.push(f); return a; }
async function bajar(f, destino) {
  const xs = [];
  if (f.nap && CLAVE_NAP) xs.push({ url: `https://nap.transportes.gob.es/api/Fichero/download/${f.nap}`, headers: { ApiKey: CLAVE_NAP } });
  if (f.u) xs.push({ url: f.u, headers: {} }); if (f.d) xs.push({ url: f.d, headers: {} });
  let ult = 'sin origen';
  for (const x of xs) { try { const r = await fetch(x.url, { headers: x.headers, redirect: 'follow', signal: AbortSignal.timeout(600_000) }); if (!r.ok) { ult = `HTTP ${r.status}`; continue; } writeFileSync(destino, Buffer.from(await r.arrayBuffer())); return; } catch (e) { ult = e.message; } }
  throw new Error(ult);
}

const informe = [];
const log = (s) => { console.log(s); informe.push(s); };
// Global (todas las fuentes de Galicia juntas): firma de cada viaje y en qué días va.
const porDiaGlobal = FECHAS.map(() => new Set());
const tam = { d7: 0, d30: 0, tipo: 0, g7: 0, g30: 0, gtipo: 0 };
const empresas = new Map();

for (const f of fuentes) {
  const zip = join(TMP, `${f.id}.zip`), dir = join(TMP, String(f.id));
  mkdirSync(dir, { recursive: true });
  try { await bajar(f, zip); execFileSync('unzip', ['-o', '-j', '-q', zip, 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'agency.txt', '-d', dir], { stdio: 'ignore' }); }
  catch (e) { if (!existsSync(join(dir, 'stop_times.txt'))) { log(`✗ ${f.id} ${f.p}: ${String(e.message).slice(0, 80)}`); continue; } }
  try {
    const paradas = new Map();
    for await (const s of filas(join(dir, 'stops.txt'))) { const la = +s.stop_lat, lo = +s.stop_lon; if (Number.isFinite(la) && Number.isFinite(lo)) paradas.set(s.stop_id, { n: s.stop_name, la, lo, g: enGalicia(la, lo) }); }
    const cal = await todas(join(dir, 'calendar.txt')), exc = await todas(join(dir, 'calendar_dates.txt'));
    const porId = new Map(cal.map((c) => [c.service_id, c])), ex = new Map();
    for (const e of exc) ex.set(`${e.service_id}|${e.date}`, e.exception_type);
    const activo = (id, d) => { const c = porId.get(id), y = iso(d).replace(/-/g, ''); let on = !!c && c[SEM[d.getUTCDay()]] === '1' && c.start_date <= y && c.end_date >= y; const e = ex.get(`${id}|${y}`); if (e === '1') on = true; else if (e === '2') on = false; return on; };
    const ids = [...new Set([...porId.keys(), ...exc.map((e) => e.service_id)])];
    const dias = new Map(ids.map((id) => [id, FECHAS.map((d) => (activo(id, d) ? '1' : '0')).join('')]));
    const ag = await todas(join(dir, 'agency.txt'));
    const agN = new Map(ag.map((a) => [a.agency_id ?? '', a.agency_name ?? '']));
    const rutas = new Map();
    for await (const r of filas(join(dir, 'routes.txt'))) rutas.set(r.route_id, { n: r.route_short_name || r.route_long_name || r.route_id, l: r.route_long_name ?? '', a: agN.get(r.agency_id ?? '') || (ag.length === 1 ? ag[0].agency_name : '') });
    const viajes = new Map();
    for await (const t of filas(join(dir, 'trips.txt'))) if (dias.get(t.service_id)?.includes('1')) viajes.set(t.trip_id, { r: t.route_id, s: t.service_id, t: [] });
    for await (const st of filas(join(dir, 'stop_times.txt'))) { const v = viajes.get(st.trip_id); if (!v) continue; const h = st.departure_time || st.arrival_time; if (!/^\d+:\d\d/.test(h)) continue; const [a, b] = h.split(':'); v.t.push([+st.stop_sequence || v.t.length, st.stop_id, +a * 60 + +b]); }
    // Solo viajes que tocan Galicia
    const lista = [];
    for (const v of viajes.values()) { if (v.t.length < 2) continue; v.t.sort((x, y) => x[0] - y[0]); if (!v.t.some((x) => paradas.get(x[1])?.g)) continue; lista.push(v); }
    viajes.clear();
    if (!lista.length) { rmSync(dir, { recursive: true, force: true }); rmSync(zip, { force: true }); continue; }
    // Firma por viaje (línea + horas) → días
    const porDia = FECHAS.map(() => new Set());
    for (const v of lista) { const k = `${f.id}|${v.r}|${v.t.map((x) => `${x[1]}@${x[2]}`).join(',')}`; const ds = dias.get(v.s); for (let i = 0; i < DIAS; i++) if (ds[i] === '1') { porDia[i].add(k); porDiaGlobal[i].add(k); } }
    // Empresas
    const muestra = new Map(); for (const v of lista) { const r = rutas.get(v.r); if (r) muestra.set(r.n, r); }
    const emp = new Set([...muestra.values()].map((r) => r.a));
    empresas.set(`${f.id} ${f.p}`, { empresas: [...emp].slice(0, 8), n: emp.size, ejemplo: [...muestra.values()].slice(0, 3).map((r) => `${r.n} · ${r.l} · ${r.a}`) });
    // Pesos: formato del paquete de la app (paradas, líneas, días, viajes) con N días
    const peso = (idx) => {
      const iP = new Map(), P = [], L = new Map(), D = new Map(), V = [], vistos = new Set();
      for (const v of lista) { const ds = idx.map((i) => dias.get(v.s)[i]).join(''); if (!ds.includes('1')) continue;
        const r = rutas.get(v.r) ?? { n: v.r, a: '' }; const kl = `${r.n}|${r.a}`; if (!L.has(kl)) L.set(kl, L.size); if (!D.has(ds)) D.set(ds, D.size);
        const pl = []; for (const x of v.t) { if (!iP.has(x[1])) { const p = paradas.get(x[1]); iP.set(x[1], P.length); P.push([p.n, '', Math.round(p.la * 1e5) / 1e5, Math.round(p.lo * 1e5) / 1e5]); } pl.push(iP.get(x[1]), x[2]); }
        const k = `${L.get(kl)}|${D.get(ds)}|${pl.join(',')}`; if (vistos.has(k)) continue; vistos.add(k); V.push([L.get(kl), D.get(ds), pl]); }
      const s = JSON.stringify({ paradas: P, lineas: [...L.keys()].map((x) => x.split('|')), dias: [...D.keys()], viajes: V });
      return [s.length, gzipSync(s).length];
    };
    // Días tipo: el laborable, sábado y domingo más corrientes (moda) + 2 festivos/días raros
    const tipo = [];
    for (const c of ['lab', 'sab', 'dom']) { const cand = FECHAS.map((d, i) => [d, i]).filter(([d]) => clase(d) === c); const firma = new Map(); for (const [, i] of cand) { const k = porDia[i].size; firma.set(k, (firma.get(k) ?? 0) + 1); } const moda = [...firma].sort((a, b) => b[1] - a[1])[0]?.[0]; const i = cand.find(([, j]) => porDia[j].size === moda)?.[1]; if (i !== undefined) tipo.push(i); }
    const raros = FECHAS.map((_, i) => i).filter((i) => !tipo.includes(i) && clase(FECHAS[i]) === 'fest').slice(0, 2);
    while (raros.length < 2) { const i = FECHAS.findIndex((d, j) => clase(d) === 'dom' && !tipo.includes(j) && !raros.includes(j)); if (i < 0) break; raros.push(i); }
    const [a7, g7] = peso([...Array(7).keys()]), [a30, g30] = peso([...Array(30).keys()]), [at, gt] = peso([...tipo, ...raros]);
    tam.d7 += a7; tam.d30 += a30; tam.tipo += at; tam.g7 += g7; tam.g30 += g30; tam.gtipo += gt;
    // Variación entre días del mismo tipo (frente al día tipo)
    const vari = [];
    for (let i = 0; i < DIAS; i++) { const c = clase(FECHAS[i]); const ref = tipo[['lab', 'sab', 'dom'].indexOf(c)]; if (ref === undefined || ref === i) continue; let mas = 0, menos = 0; for (const k of porDia[i]) if (!porDia[ref].has(k)) mas++; for (const k of porDia[ref]) if (!porDia[i].has(k)) menos++; if (mas || menos) vari.push(`${NOMBRE[FECHAS[i].getUTCDay()]} ${iso(FECHAS[i]).slice(5)} +${mas}/−${menos}`); }
    log(`✓ ${f.id} ${f.p}: ${lista.length} viajes · 7 d ${(a7 / 1e6).toFixed(2)} MB (gz ${(g7 / 1e6).toFixed(2)}) · 30 d ${(a30 / 1e6).toFixed(2)} MB (gz ${(g30 / 1e6).toFixed(2)}) · 5 días tipo ${(at / 1e6).toFixed(2)} MB (gz ${(gt / 1e6).toFixed(2)}) · días distintos de su tipo: ${vari.length}${vari.length ? ` → ${vari.slice(0, 12).join(', ')}${vari.length > 12 ? '…' : ''}` : ''}`);
  } catch (e) { log(`✗ ${f.id} ${f.p}: ${String(e.message).slice(0, 120)}`); }
  rmSync(dir, { recursive: true, force: true }); rmSync(zip, { force: true });
}
log('');
log(`TOTAL Galicia · 7 días: ${(tam.d7 / 1e6).toFixed(1)} MB (comprimido ${(tam.g7 / 1e6).toFixed(1)}) · 30 días: ${(tam.d30 / 1e6).toFixed(1)} MB (${(tam.g30 / 1e6).toFixed(1)}) · 1 mes en 5 días tipo: ${(tam.tipo / 1e6).toFixed(1)} MB (${(tam.gtipo / 1e6).toFixed(1)})`);
log('');
log('Viajes por día (todas las fuentes de Galicia):');
for (let i = 0; i < DIAS; i++) log(`  ${iso(FECHAS[i])} ${NOMBRE[FECHAS[i].getUTCDay()]} ${clase(FECHAS[i])}: ${porDiaGlobal[i].size}`);
log('');
log('Empresas por fuente:');
for (const [k, v] of empresas) log(`  ${k}: ${v.n} empresas → ${v.empresas.join(' · ')} | ej.: ${v.ejemplo.join(' ‖ ')}`);
writeFileSync('medida.txt', informe.join('\n'));
