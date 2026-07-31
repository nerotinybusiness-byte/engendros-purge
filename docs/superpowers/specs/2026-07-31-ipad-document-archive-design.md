# Archiv dokumentů z iPadu — návrh (2026-07-31)

**Autor zadání:** Martin · **Stav:** navrženo + založen základ (`docs/archive/`)

## Problém

Martin pracuje hlavně z iPadu. Dokumenty (fotky, scany, PDF, poznámky), které
přiloží do konverzace s Claudem, žijí jen v té jedné session — po jejím konci
se k nim nedá vrátit, nejdou sdílet mezi bratry a nejsou nikde verzované.
Potřebujeme trvalé, dohledatelné místo, kam se přiložené dokumenty ukládají.

## Řešení: archiv přímo v repu (`docs/archive/`)

Žádný server, žádná služba navíc — archivem je obyčejná složka v gitu:

- **Verzované a zálohované zadarmo** — historie, kdo co kdy přidal, nic se neztratí.
- **Dostupné z iPadu** — přes GitHub web/app, nebo prostě „Claude, najdi mi v archivu…".
- **Mimo deploy hry** — `docs` je už v `.vercelignore`, takže archiv nikdy
  nezvětší bundle na Vercelu.

### Struktura

```
docs/archive/
  README.md          ← návod + pravidla (jednou provždy)
  INDEX.md           ← tabulka všech dokumentů (datum, soubor, popis, kdo)
  2026/              ← jedna složka na rok
    2026-07-31-priklad-nazvu.pdf
    2026-08-02-vice-souboru-k-jedne-veci/   ← víc souborů k jednomu tématu = podsložka
```

### Pravidla pojmenování a formátů

- Název: `YYYY-MM-DD-kratky-popis-bez-diakritiky.pripona` (kebab-case).
- Preferované formáty: **PDF, PNG/JPG, MD**. iPadí formáty se převádí:
  HEIC → JPG, Pages/Numbers → PDF (převod udělá Claude při ukládání).
- Velikost: cíl **< 10 MB** na soubor (obrázky zkomprimovat); tvrdý strop
  GitHubu je 100 MB. Videa a obří soubory do archivu nepatří.
- Každý přidaný dokument = **jeden řádek v `INDEX.md`** (bez řádku v indexu
  se dokument „ztratí" stejně jako bez archivu — index je povinný).

### Workflow (jak to Martin reálně použije)

1. V session (klidně z iPadu) přiloží soubor a napíše: **„ulož to do archivu"**
   (+ pár slov, o co jde).
2. Claude: převede formát, pojmenuje podle konvence, uloží do
   `docs/archive/<rok>/`, doplní řádek do `INDEX.md`.
3. Commit `docs(archive): pridan <nazev>` na větvi `docs/archive-<datum>`,
   push, PR → druhý bratr schválí (platí normální git workflow z CLAUDE.md).
4. Zpětné hledání: „Claude, co máme v archivu k …?" → Claude čte `INDEX.md`.

### Mimo rozsah (ne-cíle)

- Žádná synchronizace na server / cloud storage — git stačí.
- Žádné UI ve hře — archiv je čistě vývojářsko-dokumentační věc.
- Žádné automatické nahrávání z iPadu mimo Claude session.

### Možná rozšíření (až bude potřeba)

- OCR/shrnutí obsahu dokumentu do sloupce v `INDEX.md`, ať se dá fulltextově hledat.
- Tematické tagy v indexu (např. `#poker`, `#mapa`, `#ucetnictvi`).
- Skript na kontrolu, že každý soubor v `docs/archive/` má řádek v indexu.
