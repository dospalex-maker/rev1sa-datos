/**
 * rev1sa-datos · Genera los horarios de transporte público de España para Rev1sa (formato PaqueteBuses de la app).
 *  - Fuentes: catálogo de Mobility Database (generar/fuentes.json, con generar/catalogo.py).
 *  - Descarga: NAP con la clave (secreto NAP_API_KEY) si la fuente está en el NAP; si no, la copia de Mobility Database
 *    y la descarga directa del operador.
 *  - Salida (carpeta `sitio/`, que se publica en GitHub Pages):
 *      indice.json            fuentes, zona real (caja de sus paradas), tipos, peso y fechas
 *      t/<fila>_<col>.json    CON CONEXIÓN: celda de 0,25° con todos los viajes que paran en ella (15 días), de todas las fuentes
 *      f/<id>.json            SIN CONEXIÓN (opcional): la fuente entera (70 días)
 *      g/galicia.json         SIN CONEXIÓN, «Toda Galicia» (2.1): semana tipo (lunes a domingo de esta semana) de todo lo que
 *                             toca Galicia; la app la repite cada semana (festivo = domingo). Medido: ~13 MB (3,4 comprimido).
 * Uso: node --max-old-space-size=6144 generar/generar.mjs [id,id,…]
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const CELDA = 0.25, DIAS_F = 70, DIAS_T = 14, RADIO_EST = 400, MAX_F = 90_000_000;
const SITIO = 'sitio', TMP = '/tmp/rev1sa-datos';
const CLAVE_NAP = process.env.NAP_API_KEY || '';
const fuentes = JSON.parse(readFileSync('generar/fuentes.json', 'utf8')).fuentes;
const solo = process.argv[2] ? new Set(process.argv[2].split(',').map(Number)) : null;
const ESTACIONES = JSON.parse(readFileSync('generar/estaciones.json', 'utf8'));
// Estaciones de Rev1sa (andenes-osm) para «autobuses junto a la estación» (estaciones-buses.json, formato DatosBuses de la app).
const ESTACIONES_APP = JSON.parse(readFileSync('generar/estaciones-andenes.json', 'utf8'));
const DESTINOS = {
  aeropuerto: /aeroporto|aeropuerto|lavacolla|alvedro|peinador|rosal[ií]a de castro/i,
  hospital: /hospital|chuac|chus\b|chuo|hula|cunqueiro|montecelo|novoa santos|materno|residencia sanitaria|complexo hospitalario/i,
  universidad: /campus|universidad|universidade|\budc\b|\busc\b|zapateira|elvi[ñn]a/i,
  centro: /\bcentro\b|praza de galicia|plaza de galicia|porta do sol|alameda|praza de espa[ñn]a/i,
  autobuses: /estaci[oó]n de autobuses|estaci[oó]n autobuses|esta[cç]i[oó]n de autobuses|intermodal/i,
};

// Base: el lunes de esta semana (como la app).
const hoy = new Date();
const lunes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - ((hoy.getUTCDay() + 6) % 7), 12));
const iso = (d) => d.toISOString().slice(0, 10);
const BASE = iso(lunes);
const FECHAS = Array.from({ length: DIAS_F }, (_, i) => new Date(lunes.getTime() + i * 86_400_000));
const SEM = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const celda = (lat, lon) => `${Math.floor(lat / CELDA)}_${Math.floor(lon / CELDA)}`;
const R = 6_371_000, rad = (x) => (x * Math.PI) / 180;
const metros = (a, b) => { const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// Estaciones por celda pequeña (0,01°) para buscar la cercana rápido.
const rejilla = new Map();
for (const e of ESTACIONES) { const k = `${Math.floor(e[1] * 100)}_${Math.floor(e[2] * 100)}`; (rejilla.get(k) ?? rejilla.set(k, []).get(k)).push(e); }
function estacionCerca(lat, lon) {
  const a = Math.floor(lat * 100), b = Math.floor(lon * 100);
  let mejor = '', d = RADIO_EST + 1;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of rejilla.get(`${a + i}_${b + j}`) ?? []) { const m = metros([lat, lon], [e[1], e[2]]); if (m < d) { d = m; mejor = e[0]; } }
  return mejor;
}

/** Una línea CSV (con comillas). */
function campos(l) {
  if (!l.includes('"')) return l.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
async function* filas(ruta) {
  if (!existsSync(ruta)) return;
  let cab = null;
  for await (let l of createInterface({ input: createReadStream(ruta, 'utf8'), crlfDelay: Infinity })) {
    if (!l.trim()) continue;
    if (!cab) { cab = campos(l.replace(/^﻿/, '')).map((x) => x.trim()); continue; }
    const c = campos(l), o = {};
    for (let i = 0; i < cab.length; i++) o[cab[i]] = (c[i] ?? '').trim();
    yield o;
  }
}
async function todas(ruta) { const a = []; for await (const f of filas(ruta)) a.push(f); return a; }

// ---------- Descarga ----------
async function bajar(f, destino) {
  const intentos = [];
  if (f.nap && CLAVE_NAP) intentos.push({ url: `https://nap.transportes.gob.es/api/Fichero/download/${f.nap}`, headers: { ApiKey: CLAVE_NAP }, o: 'nap' });
  if (f.u) intentos.push({ url: f.u, headers: {}, o: 'mdb' });
  if (f.d) intentos.push({ url: f.d, headers: {}, o: 'operador' });
  let ultimo = 'sin origen';
  for (const x of intentos) {
    try {
      const r = await fetch(x.url, { headers: x.headers, redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!r.ok) { ultimo = `${x.o} HTTP ${r.status}`; continue; }
      writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      return x.o;
    } catch (e) { ultimo = `${x.o} ${e.message}`; }
  }
  throw new Error(ultimo);
}

// ---------- Paquete (mismo formato que PaqueteBuses de la app) ----------
function construir(info, viajes, nDias) {
  const pq = { id: `mdb-${info.f.id}`, nombre: info.f.p, tipo: info.f.m ? 'urbano' : info.f.c === 'Estatales' ? 'nacional' : 'ccaa', fecha: iso(hoy), base: BASE,
    paradas: [], lineas: [], dias: [], viajes: [], ...(info.antiguo ? { antiguo: info.antiguo } : info.fin ? { fin: info.fin } : {}), ...(info.f.m ? { municipio: info.f.m } : {}) };
  const iP = new Map(), iL = new Map(), iD = new Map(), vistos = new Set();
  for (const v of viajes) {
    const dias = info.dias.get(v.s).slice(0, nDias);
    if (!dias.includes('1')) continue;
    const lin = info.lineas.get(v.r) ?? [v.r, '', 3];
    const kL = lin.join('|');
    if (!iL.has(kL)) { iL.set(kL, pq.lineas.length); pq.lineas.push(lin); }
    if (!iD.has(dias)) { iD.set(dias, pq.dias.length); pq.dias.push(dias); }
    const plano = [];
    for (let i = 0; i < v.p.length; i += 2) {
      const sid = v.p[i];
      if (!iP.has(sid)) { const d = info.paradas.get(sid); iP.set(sid, pq.paradas.length); pq.paradas.push([d.n, d.e, d.la, d.lo]); }
      plano.push(iP.get(sid), v.p[i + 1]);
    }
    const k = `${iL.get(kL)}|${iD.get(dias)}|${plano.join(',')}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    pq.viajes.push([iL.get(kL), iD.get(dias), plano]);
  }
  return pq;
}

async function procesar(f, dir) {
  // Paradas
  const paradas = new Map();
  for await (const s of filas(join(dir, 'stops.txt'))) {
    const la = Number(s.stop_lat), lo = Number(s.stop_lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) continue;
    paradas.set(s.stop_id, { n: s.stop_name ?? '', e: estacionCerca(la, lo), la: Math.round(la * 1e5) / 1e5, lo: Math.round(lo * 1e5) / 1e5, c: celda(la, lo) });
  }
  // Días de cada servicio (70 días desde el lunes)
  const cal = await todas(join(dir, 'calendar.txt')), exc = await todas(join(dir, 'calendar_dates.txt'));
  const porId = new Map(cal.map((c) => [c.service_id, c])), ex = new Map();
  for (const e of exc) ex.set(`${e.service_id}|${e.date}`, e.exception_type);
  const ids = [...new Set([...porId.keys(), ...exc.map((e) => e.service_id)])];
  const activo = (id, d) => {
    const c = porId.get(id), y = iso(d).replace(/-/g, '');
    let on = !!c && c[SEM[d.getUTCDay()]] === '1' && c.start_date <= y && c.end_date >= y;
    const e = ex.get(`${id}|${y}`); if (e === '1') on = true; else if (e === '2') on = false;
    return on;
  };
  const dias = new Map();
  for (const id of ids) dias.set(id, FECHAS.map((d) => (activo(id, d) ? '1' : '0')).join(''));
  // Caducada (ningún servicio en los 70 días): a falta de datos nuevos se reutiliza su última semana con servicio,
  // repetida por día de la semana sobre las fechas actuales (Alex, 10-11). Va marcada como «antiguo».
  let antiguo;
  if (ids.length && ![...dias.values()].some((x) => x.includes('1'))) {
    const fechas = [...cal.flatMap((c) => [c.end_date]), ...exc.filter((e) => e.exception_type === '1').map((e) => e.date)].filter((x) => /^\d{8}$/.test(x ?? '')).sort();
    const tope = fechas.pop();
    if (tope) {
      let d = new Date(Date.UTC(+tope.slice(0, 4), +tope.slice(4, 6) - 1, +tope.slice(6, 8), 12));
      for (let n = 0; n < 400 && !ids.some((id) => activo(id, d)); n++) d = new Date(d.getTime() - 86_400_000);
      if (ids.some((id) => activo(id, d))) {
        antiguo = iso(d);
        const semana = Array.from({ length: 7 }, (_, i) => new Date(d.getTime() - i * 86_400_000));
        for (const id of ids) {
          const porDia = new Map(semana.map((x) => [x.getUTCDay(), activo(id, x)]));
          dias.set(id, FECHAS.map((x) => (porDia.get(x.getUTCDay()) ? '1' : '0')).join(''));
        }
      }
    }
  }
  const finY = [...cal.map((c) => c.end_date), ...exc.filter((e) => e.exception_type === '1').map((e) => e.date)].filter((x) => /^\d{8}$/.test(x ?? '')).sort().pop();
  // Líneas
  const ag = await todas(join(dir, 'agency.txt'));
  const agencias = new Map(ag.map((a) => [a.agency_id ?? '', a.agency_name ?? '']));
  const una = ag.length === 1 ? ag[0].agency_name ?? '' : '';
  const lineas = new Map(), largos = new Map();
  for await (const r of filas(join(dir, 'routes.txt'))) {
    const rt = Number(r.route_type);
    if (r.route_long_name) largos.set(r.route_id, r.route_long_name);
    lineas.set(r.route_id, [r.route_short_name || r.route_long_name || r.route_id, agencias.get(r.agency_id ?? '') || una || f.p, Number.isFinite(rt) ? rt : 3]);
  }
  // Viajes con servicio en los 70 días
  const viajes = new Map();
  for await (const t of filas(join(dir, 'trips.txt'))) if (dias.get(t.service_id)?.includes('1')) viajes.set(t.trip_id, { r: t.route_id, s: t.service_id, h: t.trip_headsign ?? '', t: [] });
  for await (const st of filas(join(dir, 'stop_times.txt'))) {
    const v = viajes.get(st.trip_id); if (!v || !paradas.has(st.stop_id)) continue;
    const h = st.departure_time || st.arrival_time; if (!/^\d+:\d\d/.test(h)) continue;
    const [a, b] = h.split(':');
    v.t.push([Number(st.stop_sequence) || v.t.length, st.stop_id, Number(a) * 60 + Number(b)]);
  }
  const lista = [];
  for (const v of viajes.values()) {
    if (v.t.length < 2) continue;
    v.t.sort((x, y) => x[0] - y[0]);
    lista.push({ r: v.r, s: v.s, h: v.h, p: v.t.flatMap((x) => [x[1], x[2]]) });
  }
  if (!lista.length) {
    const act = [...dias.values()].filter((x) => x.includes('1')).length;
    const fechasCal = cal.flatMap((c) => [c.start_date, c.end_date]).filter(Boolean).sort();
    const fechasExc = exc.map((e) => e.date).filter(Boolean).sort();
    console.log(`  · sin viajes: servicios ${dias.size} (activos en 70 días: ${act}), calendar ${cal.length} [${fechasCal[0] ?? '-'}…${fechasCal.at(-1) ?? '-'}], calendar_dates ${exc.length} [${fechasExc[0] ?? '-'}…${fechasExc.at(-1) ?? '-'}], viajes activos ${viajes.size}, paradas ${paradas.size}`);
  }
  viajes.clear();
  return { f, paradas, dias, lineas, largos, viajes: lista, antiguo, fin: finY ? `${finY.slice(0, 4)}-${finY.slice(4, 6)}-${finY.slice(6, 8)}` : undefined };
}

// ---------- Autobuses junto a cada estación (día laborable de referencia: el próximo miércoles) ----------
const iMie = FECHAS.findIndex((d, i) => i >= 1 && d.getTime() > hoy.getTime() && d.getUTCDay() === 3);
const aHora = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const busesEstaciones = {}, fuentesBuses = [];
function estacionesBuses(info) {
  const cerca = new Map();
  for (const [sid, p] of info.paradas) for (const e of ESTACIONES_APP) {
    if (Math.abs(e[1] - p.la) > 0.005 || Math.abs(e[2] - p.lo) > 0.007) continue;
    const m = metros([p.la, p.lo], [e[1], e[2]]);
    if (m <= RADIO_EST) (cerca.get(sid) ?? cerca.set(sid, []).get(sid)).push({ est: e[0], m: Math.round(m), nombre: p.n });
  }
  if (!cerca.size) return;
  const acu = new Map();
  for (const v of info.viajes) {
    if (info.dias.get(v.s)?.[iMie] !== '1') continue;
    for (let i = 0; i < v.p.length; i += 2) for (const e of cerca.get(v.p[i]) ?? []) {
      const k = `${e.est}|${v.r}`;
      const x = acu.get(k) ?? acu.set(k, { est: e.est, r: v.r, parada: e.nombre, m: e.m, horas: [], carteles: [] }).get(k);
      if (e.m < x.m) { x.m = e.m; x.parada = e.nombre; }
      x.horas.push(v.p[i + 1]); if (v.h) x.carteles.push(v.h);
    }
  }
  for (const x of acu.values()) {
    const lin = info.lineas.get(x.r) ?? [x.r, '', 3];
    if (lin[2] !== 3 && lin[2] !== 0 && lin[2] < 700) continue; // solo bus y tranvía
    const horas = [...new Set(x.horas)].sort((a, b) => a - b);
    const cuenta = new Map(); for (const c of x.carteles) cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
    const nombre = info.largos.get(x.r) || [...cuenta].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const texto = `${nombre} ${[...cuenta.keys()].join(' ')}`;
    (busesEstaciones[x.est] ??= []).push({
      linea: lin[0], nombre, ...(lin[1] ? { operador: lin[1] } : {}), parada: x.parada, m: x.m, viajes: horas.length,
      cada: horas.length > 1 ? Math.round((horas.at(-1) - horas[0]) / (horas.length - 1)) : null,
      primero: horas.length ? aHora(horas[0]) : null, ultimo: horas.length ? aHora(horas.at(-1)) : null,
      destinos: Object.keys(DESTINOS).filter((d) => DESTINOS[d].test(texto)),
    });
  }
  fuentesBuses.push(info.f.p);
}

// ---------- Principal ----------
rmSync(SITIO, { recursive: true, force: true });
mkdirSync(join(SITIO, 't'), { recursive: true }); mkdirSync(join(SITIO, 'f'), { recursive: true }); mkdirSync(join(SITIO, 'g'), { recursive: true });
const CAJA_GAL = [41.75, -9.4, 43.9, -6.65];
const enGalicia = (p) => p && p.la >= CAJA_GAL[0] && p.la <= CAJA_GAL[2] && p.lo >= CAJA_GAL[1] && p.lo <= CAJA_GAL[3];
const galicia = [];
rmSync(join(TMP, 'celdas'), { recursive: true, force: true }); mkdirSync(join(TMP, 'celdas'), { recursive: true });
const indice = { generado: new Date().toISOString(), base: BASE, celda: CELDA, diasConexion: DIAS_T, diasSinConexion: DIAS_F, fuentes: [] };

for (const f of fuentes) {
  if (solo && !solo.has(f.id)) continue;
  const zip = join(TMP, `${f.id}.zip`), dir = join(TMP, String(f.id));
  const e = { id: f.id, p: f.p, c: f.c, m: f.m || undefined, z: f.z, v: f.v };
  try {
    e.origen = await bajar(f, zip);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-j', '-q', zip, 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'agency.txt', '-d', dir], { stdio: 'ignore' });
  } catch (err) {
    if (!existsSync(join(dir, 'stop_times.txt'))) { e.error = String(err.message).slice(0, 200); indice.fuentes.push(e); console.log(`✗ ${f.id} ${f.p}: ${e.error}`); continue; }
  }
  try {
    const info = await procesar(f, dir);
    // Caja real y tipos
    let b = null; const tipos = new Set();
    for (const p of info.paradas.values()) b = b ? [Math.min(b[0], p.la), Math.min(b[1], p.lo), Math.max(b[2], p.la), Math.max(b[3], p.lo)] : [p.la, p.lo, p.la, p.lo];
    for (const l of info.lineas.values()) tipos.add(l[2]);
    Object.assign(e, { b, tipos: [...tipos], fin: info.fin, viajes: info.viajes.length, ...(info.antiguo ? { antiguo: info.antiguo } : {}) });
    if (iMie >= 0) estacionesBuses(info);
    // 2.1 · «Toda Galicia»: semana tipo de los viajes que paran en Galicia (de fuentes gallegas y estatales).
    if (f.c === 'Galicia' || /Galicia/.test(f.z ?? '') || f.z === '*' || f.c === 'Estatales') {
      const vg = info.viajes.filter((v) => { for (let i = 0; i < v.p.length; i += 2) if (enGalicia(info.paradas.get(v.p[i]))) return true; return false; });
      if (vg.length) { const pq = construir(info, vg, 7); if (pq.viajes.length) galicia.push(pq); }
    }
    // Sin conexión: la fuente entera
    const entera = JSON.stringify(construir(info, info.viajes, DIAS_F));
    if (entera.length <= MAX_F) { writeFileSync(join(SITIO, 'f', `${f.id}.json`), entera); e.bytes = entera.length; } else e.grande = entera.length;
    // Con conexión: por celdas (viajes que paran en ella sin ser su última parada)
    const porCelda = new Map();
    for (const v of info.viajes) {
      const cs = new Set(); for (let i = 0; i < v.p.length - 2; i += 2) cs.add(info.paradas.get(v.p[i]).c);
      for (const c of cs) (porCelda.get(c) ?? porCelda.set(c, []).get(c)).push(v);
    }
    e.celdas = 0;
    for (const [c, vs] of porCelda) {
      const pq = construir(info, vs, DIAS_T);
      if (!pq.viajes.length) continue;
      const ruta = join(TMP, 'celdas', `${c}.part`);
      appendFileSync(ruta, (existsSync(ruta) ? ',' : '') + JSON.stringify(pq));
      e.celdas++;
    }
    console.log(`✓ ${f.id} ${f.p}: ${info.viajes.length} viajes${info.antiguo ? ` (reutilizada: semana hasta ${info.antiguo})` : ''}, ${e.celdas} celdas, ${e.bytes ?? e.grande} B (${e.origen})`);
  } catch (err) { e.error = String(err.message).slice(0, 200); console.log(`✗ ${f.id} ${f.p}: ${e.error}`); }
  rmSync(dir, { recursive: true, force: true }); rmSync(zip, { force: true });
  indice.fuentes.push(e);
}
// GitHub Pages admite ~1 GB: si no cabe todo, se quitan los paquetes «sin conexión» más grandes (las celdas van siempre).
const LIMITE = 950_000_000;
let ocupado = indice.fuentes.reduce((a, x) => a + (x.bytes ?? 0), 0);
for (const n of readdirSync(join(TMP, 'celdas'))) ocupado += statSync(join(TMP, 'celdas', n)).size + 2;
for (const x of [...indice.fuentes].filter((y) => y.bytes).sort((a, b) => b.bytes - a.bytes)) {
  if (ocupado <= LIMITE) break;
  rmSync(join(SITIO, 'f', `${x.id}.json`), { force: true }); ocupado -= x.bytes; x.grande = x.bytes; delete x.bytes;
}
// Celdas: [paquete, paquete, …]
const celdas = [];
for (const n of readdirSync(join(TMP, 'celdas'))) {
  const c = n.replace('.part', '');
  writeFileSync(join(SITIO, 't', `${c}.json`), `[${readFileSync(join(TMP, 'celdas', n), 'utf8')}]`);
  celdas.push([c, statSync(join(SITIO, 't', `${c}.json`)).size]);
}
indice.celdas = Object.fromEntries(celdas);
if (galicia.length) { const g = JSON.stringify(galicia); writeFileSync(join(SITIO, 'g', 'galicia.json'), g); indice.galicia = { bytes: g.length, base: BASE, fuentes: galicia.map((x) => x.nombre) }; console.log(`Galicia (semana tipo): ${galicia.length} fuentes, ${(g.length / 1e6).toFixed(1)} MB`); }
for (const k of Object.keys(busesEstaciones)) busesEstaciones[k] = busesEstaciones[k].sort((a, b) => b.destinos.length - a.destinos.length || b.viajes - a.viajes).slice(0, 12);
writeFileSync(join(SITIO, 'estaciones-buses.json'), JSON.stringify({ fecha: iso(hoy), fuentes: fuentesBuses, estaciones: busesEstaciones }));
writeFileSync(join(SITIO, 'indice.json'), JSON.stringify(indice));
writeFileSync(join(SITIO, '.nojekyll'), '');
const total = celdas.reduce((a, x) => a + x[1], 0) + indice.fuentes.reduce((a, x) => a + (x.bytes ?? 0), 0);
console.log(`Fuentes: ${indice.fuentes.length} (${indice.fuentes.filter((x) => x.error).length} con error) · celdas: ${celdas.length} · total ${(total / 1e6).toFixed(0)} MB`);
