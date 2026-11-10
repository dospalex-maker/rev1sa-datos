"""
Genera generar/fuentes.json (rev1sa-datos): fuentes GTFS de España del catálogo de Mobility Database
(https://github.com/MobilityData/mobility-database-catalogs, CC0), con su comunidad autónoma y el id del NAP.
Uso:  git clone --depth 1 https://github.com/MobilityData/mobility-database-catalogs /tmp/mdbc
      python generar/catalogo.py /tmp/mdbc
"""
import glob, json, re, sys, datetime

CCAA = {
    'guipúzcoa': 'País Vasco', 'gipuzkoa': 'País Vasco', 'biscay': 'País Vasco', 'bizkaia': 'País Vasco', 'álava': 'País Vasco',
    'catalonia': 'Cataluña', 'catalunya': 'Cataluña', 'barcelona': 'Cataluña', 'tarragona': 'Cataluña', 'girona': 'Cataluña', 'lleida': 'Cataluña',
    'madrid': 'Madrid', 'balearic islands': 'Islas Baleares', 'baleares': 'Islas Baleares', 'pm': 'Islas Baleares',
    'andalusia': 'Andalucía', 'andalucía': 'Andalucía', 'almeria': 'Andalucía', 'córdoba': 'Andalucía', 'sevilla': 'Andalucía',
    'castile and león': 'Castilla y León', 'castilla y león': 'Castilla y León', 'ávila': 'Castilla y León',
    'galicia': 'Galicia', 'aragon': 'Aragón', 'alicante': 'Comunidad Valenciana', 'valència': 'Comunidad Valenciana', 'valencian community': 'Comunidad Valenciana',
    'cantabria': 'Cantabria', 'navarre': 'Navarra', 'navarra': 'Navarra', 'cáceres': 'Extremadura', 'extremadura': 'Extremadura',
    'canarias': 'Canarias', 'canary islands': 'Canarias', 'santa cruz de tenerife': 'Canarias', 'tenerife': 'Canarias',
    'castile-la mancha': 'Castilla-La Mancha', 'toledo': 'Castilla-La Mancha', 'murcia': 'Región de Murcia', 'navarra, comunidad foral de': 'Navarra', 'valenciana, comunidad': 'Comunidad Valenciana', 'valenciana, comunitat': 'Comunidad Valenciana',
    'valladolid': 'Castilla y León', 'zaragoza': 'Aragón',
}
# Sin comunidad en el catálogo: a mano (None = fuera).
A_MANO = {
    2727: None, 1914: None, 2825: 'Estatales', 2712: 'Estatales', 2810: 'Estatales', 2817: 'Estatales', 2809: 'Estatales', 2811: 'Estatales',
    2785: 'Estatales', 2620: 'Estatales', 2717: 'Estatales', 2653: 'Estatales', 2794: 'Estatales', 1064: 'Estatales', 790: 'Estatales', 1065: 'Estatales',
    2827: 'Asturias', 2826: 'Cataluña', 2832: 'Cataluña', 2752: 'Galicia', 2748: 'Cantabria', 2749: 'Cataluña', 2751: 'Cataluña', 2750: 'Cataluña',
    2754: 'Cataluña', 2753: 'Cataluña', 2755: 'Cataluña', 2716: 'Cataluña', 3145: 'Castilla y León', 3181: 'Castilla y León', 3455: 'Castilla y León',
    3454: 'Castilla y León', 2715: 'País Vasco', 2756: 'País Vasco', 2776: 'País Vasco', 3052: 'País Vasco', 2718: 'Región de Murcia', 2828: 'Región de Murcia',
    1079: 'Islas Baleares', 2830: 'Comunidad Valenciana', 2829: 'Comunidad Valenciana', 2141: 'Islas Baleares',
}
MUNI = {'lledia': 'Lleida'}
# 1.15.18: comunidades por las que pasan las fuentes estatales (el catálogo no da su zona y, si van por el NAP con clave, tampoco
# su caja de coordenadas). '*' = toda España. Sirve para no enseñar, p. ej., Huesca–Barcelona en Santiago.
COBERTURA = {
    2825: '*', 2620: '*', 2653: '*', 790: '*', 1065: '*', 2717: 'Galicia,Asturias,Cantabria,País Vasco,Castilla y León,Región de Murcia', 1064: 'Galicia,Asturias,Cantabria,País Vasco,Castilla y León,Región de Murcia',
    2712: 'Madrid,Castilla-La Mancha,Andalucía,Aragón,Castilla y León', 2810: 'Aragón,Cataluña', 2809: 'Aragón,Cataluña',
    2817: 'Madrid,Castilla-La Mancha,Andalucía', 2811: 'Madrid,Castilla-La Mancha', 2794: 'Madrid,Castilla y León',
    2785: 'Madrid,Cataluña,Aragón,Comunidad Valenciana,Andalucía,Castilla y León,Región de Murcia,Castilla-La Mancha',
}
# Fuera siempre: 1914 es de Santiago de los Caballeros (República Dominicana); 2727 son franjas horarias, no transporte.
NUNCA = {1914, 2727}
norm = lambda x: re.sub(r'[^a-z0-9]', '', x.lower())

def main(raiz):
    out = []
    todas = [json.load(open(f, encoding='utf-8')) for f in sorted(glob.glob(f'{raiz}/catalogs/sources/gtfs/schedule/es-*.json'))]
    # 1.15.18 (Alex: «todas las fuentes»): también las antiguas, salvo si hay otra activa del mismo operador (sería repetida).
    vivas = {norm(d['provider']) for d in todas if d.get('status') not in ('deprecated', 'inactive')}
    for d in todas:
        i = d['mdb_source_id']
        if i in NUNCA:
            continue
        vieja = d.get('status') in ('deprecated', 'inactive')
        if vieja and norm(d['provider']) in vivas:
            continue
        loc = d['location']
        s = (loc.get('subdivision_name') or '').strip()
        c = A_MANO[i] if i in A_MANO else CCAA.get(s.lower())
        if c is None:
            if i not in A_MANO: print('SIN COMUNIDAD:', i, d['provider'], s, file=sys.stderr)
            continue
        dd = d['urls'].get('direct_download', '')
        m = re.search(r'nap\.transportes\.gob\.es/api/Fichero/download/(\d+)', dd)
        e = {'id': i, 'p': d['provider'], 'c': c, 'm': MUNI.get((loc.get('municipality') or '').lower(), loc.get('municipality') or ''), 'u': d['urls'].get('latest', '')}
        if m: e['nap'] = int(m.group(1))
        elif dd and dd != e['u']: e['d'] = dd  # descarga directa del operador (de reserva)
        b = loc.get('bounding_box') or {}
        if b.get('minimum_latitude') is not None:
            e['b'] = [round(b['minimum_latitude'], 3), round(b['minimum_longitude'], 3), round(b['maximum_latitude'], 3), round(b['maximum_longitude'], 3)]
        if i in COBERTURA: e['z'] = COBERTURA[i]
        if vieja: e['v'] = 1
        out.append(e)
    json.dump({'fuente': 'Mobility Database (CC0)', 'fecha': datetime.date.today().isoformat(), 'fuentes': out},
              open('generar/fuentes.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(len(out), 'fuentes')

main(sys.argv[1])
