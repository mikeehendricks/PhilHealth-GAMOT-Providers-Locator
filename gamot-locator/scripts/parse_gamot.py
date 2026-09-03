import pdfplumber, re, json, sys

REGION_MAP = {
    "CORDILLERA ADMINISTRATIVE REGION": "Cordillera Administrative Region (CAR)",
    "REGION I": "Region I (Ilocos Region)",
    "REGION II": "Region II (Cagayan Valley)",
    "REGION III": "Region III (Central Luzon)",
    "NATIONAL CAPITAL REGION & RIZAL": "National Capital Region (NCR)",
    "REGION IV-A": "Region IV-A (CALABARZON)",
    "REGION IV-B": "Region IV-B (MIMAROPA)",
    "REGION V": "Region V (Bicol Region)",
    "REGION VI": "Region VI (Western Visayas)",
    "REGION VII": "Region VII (Central Visayas)",
    "REGION VIII": "Region VIII (Eastern Visayas)",
    "REGION IX": "Region IX (Zamboanga Peninsula)",
    "REGION X": "Region X (Northern Mindanao)",
    "REGION XI": "Region XI (Davao Region)",
    "REGION XII": "Region XII (SOCCSKSARGEN)",
    "CARAGA REGION": "Caraga",
    "BANGSAMORO AUTONOMOUS REGION OF MUSLIM MINDANAO": "Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)",
}

# NCR cities/municipalities -> province "Metro Manila"
PROV_NORM = {
    "PROVINCE OF RIZAL": "Rizal",
    "CEBU PROVINCE": "Cebu",
    "ILOILO PROVINCE": "Iloilo",
    "ILOILO CITY": "Iloilo",
}

NCR_LOCAL = {
    "CALOOCAN CITY","CITY OF MANILA","LAS PIÑAS CITY","MAKATI CITY","MALABON CITY",
    "MANDALUYONG CITY","MARIKINA CITY","MUNTINLUPA CITY","NAVOTAS CITY","PARAÑAQUE CITY",
    "PASAY CITY","PASIG CITY","PATEROS","QUEZON CITY","TAGUIG CITY","VALENZUELA CITY",
}

def clean(s):
    if s is None: return ""
    s = str(s)
    s = s.replace("\u00d1","Ñ").replace("\u00f1","ñ")  # fix N with tilde
    s = s.replace("Ã‘","Ñ").replace("Ã±","ñ")  # fix mojibake N-tilde
    s = s.replace("Ã","Ñ")  # any leftover mojibake A-tilde
    s = s.replace("\n", " ").replace("\r"," ")
    s = re.sub(r"\s+", " ", s).strip()
    return s

def is_region(name):
    return "REGION" in name.upper() or name.upper().startswith("CARAGA") or "BANGSAMORO" in name.upper()

providers = []
region = ""
province = ""

with pdfplumber.open("uploads/GAMOT.pdf") as pdf:
    for pi, page in enumerate(pdf.pages):
        tbl = page.extract_table()
        if not tbl: continue
        for row in tbl:
            if not row or all(c is None or str(c).strip()=='' for c in row):
                continue
            c0 = clean(row[0])
            if c0 == "":
                continue
            if c0 == "NAME OF HEALTH FACILITY":
                continue
            if c0.isdigit():
                # data row
                num = int(c0)
                name = clean(row[1]) if len(row)>1 else ""
                tel = clean(row[2]) if len(row)>2 else ""
                email = clean(row[3]) if len(row)>3 else ""
                street = clean(row[4]) if len(row)>4 else ""
                city = clean(row[5]) if len(row)>5 else ""
                expire = clean(row[6]) if len(row)>6 else ""
                sec = clean(row[7]) if len(row)>7 else ""
                prov = province
                if province in NCR_LOCAL:
                    prov = "Metro Manila"
                reg = region
                if province == "Rizal":
                    reg = "Region IV-A (CALABARZON)"
                providers.append({
                    "id": num,
                    "name": name,
                    "tel": tel,
                    "email": email,
                    "street": street,
                    "city": city,
                    "province": prov,
                    "region": reg,
                    "expire": expire,
                    "sector": sec,
                })
            else:
                # header row
                if is_region(c0):
                    region = REGION_MAP.get(c0, c0)
                else:
                    province = PROV_NORM.get(c0, c0)

print("Total parsed:", len(providers))
# validate sequence
nums = [p["id"] for p in providers]
print("Min:", min(nums), "Max:", max(nums), "Unique:", len(set(nums)))
missing = [i for i in range(1, nums[-1]+1) if i not in set(nums)]
print("Missing numbers:", missing[:20], "count:", len(missing))
# show a few
for p in providers[:3]:
    print(p)
print("...")
for p in providers[-3:]:
    print(p)

json.dump(providers, open("providers_raw.json","w"), ensure_ascii=False, indent=1)
print("saved providers_raw.json")
