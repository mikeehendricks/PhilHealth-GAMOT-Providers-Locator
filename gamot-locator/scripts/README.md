# Data generation scripts

These scripts document how `data/providers.json` is produced from the official
PhilHealth GAMOT package provider list (a multi-page PDF).

Pipeline:

1. **`parse_gamot.py`** — extracts all provider records from the PDF using
   `pdfplumber`'s table extraction. Output: `providers_raw.json`.

   ```bash
   pip install pdfplumber
   # place the source PDF at uploads/GAMOT.pdf, then:
   python3 parse_gamot.py
   ```

   This normalizes:
   - UTF-8 mojibake of `Ñ` (e.g. `LAS PIÃ'AS` → `LAS PIÑAS`),
   - region / province grouping (e.g. `PROVINCE OF RIZAL` → `Rizal`),
   - NCR municipalities → province `Metro Manila`,
   - Batangas → corrected to CALABARZON (the source PDF groups it under
     Region IV-B, which is a known quirk).

2. **`geocode.py`** — geocodes each unique `(city, province)` pair to
   coordinates using Photon (primary) with a Nominatim fallback, with manual
   overrides for abbreviation/typo cases. Caches results in
   `geocode_cache.json` (committed so re-runs are instant).

   ```bash
   python3 geocode.py all    # geocode missing pairs (rate-limited, ~1 req/s)
   ```

3. **`build_data.py`** — joins the geocoded coordinates back onto every
   provider and applies title-casing, then writes `data/providers.json`.

   ```bash
   python3 build_data.py
   ```

Notes:

- Coordinates represent the **municipality/city center**, not a precise street
  address (the source list has no street-level coordinates).
- `geocode_cache.json` contains 797 unique localities; a handful of entries
  were hand-corrected (e.g. `KABANGLASAN` → Cabanglasan, `LAWA-AN` → Laua-an,
  `WRIGHT` → Paranas).
