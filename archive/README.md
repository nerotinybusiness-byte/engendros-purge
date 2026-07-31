# Archiv dokumentů z iPadu

Trvalé úložiště pro dokumenty přiložené v Claude sessions (fotky, PDF, poznámky…),
aby nezmizely s koncem session. Prohlížení: **`/archive.html`** (lokálně i na
`https://engendros-purge.vercel.app/archive.html`). Návrh a detaily:
`docs/superpowers/specs/2026-07-31-ipad-document-archive-design.md`.

## Jak přidat záznam (dělá Claude, když mu pošleš přílohu)

1. Založ složku `archive/YYYY-MM-DD-kratky-nazev/` (datum = dnešek).
2. Ulož do ní soubory. **Fotky z iPadu (HEIC) převeď na JPEG/PNG**; velké fotky
   zmenši (~rozumný strop 10 MB na soubor, GitHub limit je 100 MB).
3. Volitelně přidej `poznamka.md` — první `# nadpis` je titulek záznamu,
   první odstavec je popis v prohlížečce.
4. Přegeneruj index: `node scripts/archive-index.js`
   (vytvoří `index.json` + `INDEX.md` — ty se **needitují ručně**).
5. Commit + push na feature větev → PR → po merge je archiv živě na Vercelu.

## Jak uložit dokument (z iPadu — celý postup pro Martina)

1. V Claude session **přilož soubor do chatu**.
2. Napiš: *„ulož to do archivu"* + jednou větou k čemu to je.
3. Claude ho uloží podle konvence výše, přegeneruje index, commitne a pushne
   na feature větvi → PR → druhý brácha schválí → merge → je to živě.

Session smí zaniknout kdykoli — jakmile je push venku, nic se neztratí.

## Pravidla

- Archiv je po deployi **veřejně dostupný** — nedávat sem nic citlivého
  (doklady, hesla, osobní údaje). Jen věci k projektu.
- Soubory nad ~10 MB jen po domluvě — git si je pamatuje navždy a zpomalují
  každý Vercel deploy.
- Každý přírůstek projde generátorem — záznam bez přegenerovaného indexu je
  k nenalezení. Volné soubory přímo v `archive/` (mimo složky záznamů)
  index ignoruje.

## Pro Claude (instrukce do budoucích sessions)

Když se úkol týká archivu nebo dřívějších podkladů, **nejdřív si přečti
`archive/INDEX.md`** (případně `index.json`) — je to jediná trvalá paměť
napříč sessions. Při ukládání dodrž konvenci výše a vždy přegeneruj index
(`node scripts/archive-index.js`).
