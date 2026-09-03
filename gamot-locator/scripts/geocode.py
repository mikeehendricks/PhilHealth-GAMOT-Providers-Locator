import json, re, time, sys, urllib.parse, urllib.request

# ---------- city normalization ----------
def norm_city(c):
    c = c.strip()
    c = re.sub(r'\s*\(.*?\)\s*$', '', c)
    if re.search(r',\s*MANILA\s*$', c.upper()):
        return 'Manila'
    return c

# ---------- region alias extraction ----------
def region_alias(region):
    m = re.search(r'\(([^)]+)\)', region)
    if m: return m.group(1)
    return None

PLACE_RANK = {'city': 6, 'town': 5, 'municipality': 5, 'village': 4,
              'district': 3, 'borough': 3, 'quarter': 2, 'hamlet': 2,
              'island': 2, 'state': 4, 'county': 4, 'locality': 1}

def http_get(url, ua, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept-Language': 'en'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def photon_features(q, limit=20):
    url = 'https://photon.komoot.io/api/?' + urllib.parse.urlencode({'q': q, 'limit': limit})
    d = http_get(url, 'GAMOT-Locator/1.0')
    return d.get('features', [])

def nominatim(q):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        'q': q, 'format': 'json', 'limit': 3, 'countrycodes': 'ph'})
    d = http_get(url, 'GAMOT-Locator/1.0 (contact: philhealth-gamot@example.com)')
    for r in d:
        yield {'lat': float(r['lat']), 'lon': float(r['lon']),
               'name': r.get('display_name','').split(',')[0],
               'rank': 5, 'state': r.get('display_name','')}

def score(cand, city_norm, province, aliases):
    """higher is better"""
    s = PLACE_RANK.get(cand.get('rank', 'locality'), 1)
    name = (cand.get('name') or '').lower()
    cn = city_norm.lower()
    state = (cand.get('state') or '').lower()
    # name match
    if name == cn:
        s += 4
    elif cn in name or name in cn:
        s += 2
    # state match (province or region alias)
    if province.lower() in state or state in province.lower():
        s += 3
    for a in aliases:
        if a and a.lower() in state:
            s += 2
    return s

def geocode_pair(city_norm, province, region):
    aliases = set()
    ra = region_alias(region)
    if ra: aliases.add(ra)
    aliases.add('metro manila')
    # base query forms
    qforms = []
    cn = city_norm
    # strip trailing 'City' variant
    cn_nocity = re.sub(r'\s*City\s*$', '', city_norm, flags=re.I)
    variants = []
    for v in (cn, cn_nocity):
        if v not in variants: variants.append(v)
    for v in variants:
        if province == 'Metro Manila':
            qforms.append(f"{v}, Metro Manila, Philippines")
            qforms.append(f"{v}, Philippines")
        elif province.upper() == v.upper():
            qforms.append(f"{v}, Philippines")
        else:
            qforms.append(f"{v}, {province}, Philippines")
            qforms.append(f"{v}, Philippines")
    # collect candidates
    best = None; best_score = -1
    seen = set()
    for q in qforms:
        try:
            feats = photon_features(q)
        except Exception as e:
            sys.stderr.write(f"  photon ERR {q}: {e}\n")
            time.sleep(2); continue
        for f in feats:
            p = f['properties']; g = f['geometry']['coordinates']
            if p.get('osm_key') != 'place': continue
            ov = p.get('osm_value')
            if ov not in PLACE_RANK: continue
            cand = {'lat': g[1], 'lon': g[0], 'name': p.get('name') or '',
                    'state': p.get('state') or '', 'rank': ov}
            sc = score(cand, city_norm, province, aliases)
            key = (round(cand['lat'],5), round(cand['lon'],5))
            if key in seen: continue
            seen.add(key)
            if sc > best_score:
                best_score = sc; best = cand
        time.sleep(0.4)
    if best:
        return best
    # fallback Nominatim
    for q in qforms[:2]:
        try:
            for c in nominatim(q):
                return c
        except Exception as e:
            sys.stderr.write(f"  nom ERR {q}: {e}\n"); time.sleep(3)
    return None

# ---------- main ----------
if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    data = json.load(open('providers_raw.json'))
    for p in data:
        p['city_norm'] = norm_city(p['city'])
    pairs = {}
    for p in data:
        pairs.setdefault((p['city_norm'], p['province'], p['region']), []).append(p['id'])
    def kstr(t): return t[0]+"||"+t[1]
    try:
        cache = json.load(open('geocode_cache.json'))
    except Exception:
        cache = {}

    if mode == 'test':
        for (cn, prov, reg) in list(pairs)[:0]:
            pass
        samples = [
            ('Manila','Metro Manila','National Capital Region (NCR)'),
            ('Lapu-Lapu City','Cebu','Region VII (Central Visayas)'),
            ('Rodriguez','Rizal','National Capital Region & Rizal'),
            ('Bongao','Tawi-Tawi','Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)'),
            ('El Nido','Palawan','Region IV-B (MIMAROPA)'),
            ('Daraga','Albay','Region V (Bicol Region)'),
            ('San Juan','Metro Manila','National Capital Region (NCR)'),
            ('Quezon City','Metro Manila','National Capital Region (NCR)'),
            ('Calanasan','Apayao','Cordillera Administrative Region (CAR)'),
            ('Santa Cruz','Manila','National Capital Region (NCR)'),
        ]
        for cn, prov, reg in samples:
            r = geocode_pair(cn, prov, reg)
            print(f"{cn:18} | {prov:14} -> {('%.5f,%.5f'%(r['lat'],r['lon'])) if r else 'FAILED'}{('  ['+r.get('name','')+']') if r else ''}")
            time.sleep(0.3)
        sys.exit(0)

    todo = [t for t in pairs if kstr(t) not in cache or not cache[kstr(t)]]
    print("to geocode:", len(todo)); sys.stdout.flush()
    for i,(cn,prov,reg) in enumerate(todo):
        res = geocode_pair(cn, prov, reg)
        cache[kstr((cn,prov,reg))] = res
        json.dump(cache, open('geocode_cache.json','w'), ensure_ascii=False)
        if res:
            print(f"[{i+1}/{len(todo)}] {cn} | {prov} -> {res['lat']:.5f},{res['lon']:.5f} [{res.get('name','')}]")
        else:
            print(f"[{i+1}/{len(todo)}] {cn} | {prov} -> FAILED")
        sys.stdout.flush()
        time.sleep(0.4)
    print("DONE", len(cache))
