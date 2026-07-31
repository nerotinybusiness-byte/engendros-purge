# Archiv dokumentů (z iPadu)

Trvalé úložiště pro dokumenty přiložené do Claude sessions — fotky, náčrty,
poznámky, PDF reference. Všechno je v gitu: verzované, zálohované na GitHubu,
prohlížitelné z iPadu přes GitHub aplikaci. Celé `docs/` je vyřazené z Vercel
deploye, takže archiv nikdy neskončí v produkci.

## Jak přidat dokument

1. V Claude session přilož soubor a napiš **„ulož do archivu"** (+ ideálně
   kategorii a jednou větou k čemu to je).
2. Claude ho uloží jako `<kategorie>/YYYY-MM-DD-kratky-popis.pripona`
   (datum přiložení, popis kebab-case bez diakritiky).
3. Claude přidá řádek do [`INDEX.md`](INDEX.md), commitne a pushne
   (feature větev → PR → schválení).

## Kategorie

| Složka | Co tam patří |
|---|---|
| `napady/` | nápady, náčrty, design poznámky |
| `reference/` | reference obrázky/PDF — zbraně, budovy, technika |
| `screenshoty/` | QA / bug screenshoty ze hry |
| `ostatni/` | všechno ostatní |

## Pravidla velikosti

- Cíl **< 2 MB** na soubor — fotky z iPadu se před uložením konvertují na JPEG
  a zmenšují na ~1600 px delší stranu.
- Tvrdý strop **10 MB** — větší soubory sem nepatří (do INDEXu jde jen odkaz).
- Video se do archivu nedává.

Návrh a zdůvodnění: `docs/superpowers/specs/2026-07-31-ipad-document-archive-design.md`.
