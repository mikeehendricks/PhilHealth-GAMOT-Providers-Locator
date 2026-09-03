import json, re

def norm_city(c):
    c = c.strip()
    c = re.sub(r'\s*\(.*?\)\s*$', '', c)
    if re.search(r',\s*MANILA\s*$', c.upper()):
        return 'Manila'
    return c

def title(s):
    # title-case while preserving common acronyms like "RHU", "III", "II"
    words = s.split()
    out = []
    for w in words:
        # keep things like "R.H.U." as-is but generally title-case
        if w.isupper() and len(w) <= 4 and not any(c.isdigit() for c in w):
            out.append(w)  # keep short all-caps acronyms
        else:
            out.append(w.capitalize())
    return " ".join(out)

def title_keep(s):
    # smarter title case: title each word but keep already-caps acronyms and roman numerals
    return re.sub(r"[A-Za-z]+('[A-Za-z]+)?",
                  lambda m: m.group(0) if (m.group(0).isupper() and len(m.group(0))<=3) else m.group(0).capitalize(),
                  s)

ROMAN = {'I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'}
KEEP_UP = {'RHU','MHO','PHO','R.H.U.','M.H.O.','P.H.O.','N.H.I.P.','N.H.I.P'}
SMALL = {'and','of','the','in','for','at','with','de','del','ni','ng','sa','na','on','by'}
def final_title(s):
    tokens = re.split(r'(\s+|-)', s)
    out = []
    for t in tokens:
        if t == '' or t.isspace() or t == '-':
            out.append(t); continue
        u = t.upper()
        if u in ROMAN or u in KEEP_UP:
            out.append(u); continue
        if any(ch.isdigit() for ch in t):
            out.append(t); continue
        l = t.lower()
        if l in SMALL:
            out.append(l); continue
        m = re.match(r'^(\W*)(\w)(.*)$', t)
        if m:
            out.append(m.group(1) + m.group(2).upper() + m.group(3).lower())
        else:
            out.append(t)
    return ''.join(out)

d = json.load(open('providers_raw.json'))
cache = json.load(open('geocode_cache.json'))

SECTOR = {'P': 'Private', 'G': 'Government', '': 'Private'}
out = []
missing = []
for p in d:
    cn = norm_city(p['city'])
    key = cn + "||" + p['province']
    loc = cache.get(key)
    if not loc:
        missing.append(key); continue
    region = p['region']
    if p['province'] == 'BATANGAS':
        region = 'Region IV-A (CALABARZON)'
    out.append({
        'id': p['id'],
        'name': final_title(p['name']),
        'tel': p['tel'],
        'email': p['email'],
        'street': final_title(p['street']),
        'city': final_title(cn),
        'province': final_title(p['province']),
        'region': region,
        'expire': p['expire'],
        'sector': SECTOR.get(p['sector'], 'Private'),
        'sector_code': p['sector'],
        'lat': round(loc['lat'], 6),
        'lon': round(loc['lon'], 6),
    })

print("providers with coords:", len(out))
print("missing:", missing)
# sanity: all lat/lon in PH bounds
bad = [o for o in out if not (4.5 <= o['lat'] <= 21.5 and 116.5 <= o['lon'] <= 127.5)]
print("out of bounds:", len(bad))
for o in bad[:10]: print("  ", o['id'], o['name'], o['lat'], o['lon'])

json.dump(out, open('providers.json','w'), ensure_ascii=False, separators=(',',':'))
print("wrote providers.json, size:", len(json.dumps(out)))
