# iPad Document Archive — návrh úložiště pro přiložené dokumenty

**Datum:** 2026-07-31 · **Autor požadavku:** Martin · **Větev:** `claude/ipad-document-storage-a9l16r`

## Problém

Martin pracuje na hře z iPadu a do Claude sessions přikládá dokumenty — fotky,
screenshoty, náčrty, poznámky, PDF reference. Ty dnes po skončení session
**zmizí**: session kontejner je dočasný a přílohy se nikam neukládají. Chybí
trvalé, verzované místo, kam se přiložený dokument uloží, dá se k němu vrátit
a dá se na něj odkázat z design doců a PR.

> Pozn.: v repu, issues, PR ani git historii žádný dřívější zápis o tomhle
> tématu neexistuje — tenhle dokument je první písemný záznam. Pokud existují
> starší poznámky mimo repo (chat, poznámky v iPadu), přiloží se do archivu
> jako první položky.

## Řešení — `docs/archive/` přímo v repu

Žádný externí server, žádná databáze. Archiv je **složka v gitu** — dostane
zdarma verzování, zálohu na GitHubu, prohlížení z iPadu přes GitHub aplikaci
a odkazovatelnost (`docs/archive/…` funguje jako link v každém .md a PR).

`docs/` je už dnes celé vyřazené z Vercel deploye (`.vercelignore`), takže
archiv **nikdy nenafoukne produkční bundle** — jen git repo.

### Struktura

```
docs/archive/
  README.md        ← manuál: jak přiložit, pojmenovat, zaindexovat
  INDEX.md         ← živý index — jedna řádka na dokument
  napady/          ← nápady, náčrty, design poznámky
  reference/       ← reference obrázky/PDF (zbraně, budovy, technika)
  screenshoty/     ← QA / bug screenshoty ze hry
  ostatni/         ← všechno ostatní
```

### Workflow (z iPadu)

1. Martin v Claude session **přiloží soubor** a řekne „ulož do archivu"
   (+ volitelně kategorii a k čemu to je).
2. Claude soubor uloží jako `docs/archive/<kategorie>/YYYY-MM-DD-kratky-popis.pripona`
   (datum = den přiložení, popis kebab-case, bez diakritiky).
3. Claude přidá řádek do `INDEX.md` (datum, soubor, kategorie, jednověté „co to je
   a proč"), commitne a pushne na feature větev → PR → brácha schválí.

### Pravidla velikosti

- **Cíl < 2 MB na soubor** — fotky z iPadu (HEIC/12 MPx) Claude před uložením
  překonvertuje na JPEG a zmenší na ~1600 px delší stranu.
- **Tvrdý strop 10 MB** — větší soubor se neukládá; místo něj jde do INDEXu
  odkaz na externí umístění. Git je špatné úložiště velkých binárek a repo už
  teď nese těžké GLB modely.
- PDF se ukládají tak, jak jsou (bývají malé); video se do archivu nedává.

## Co se v této větvi udělalo (hotovo)

- Tento design doc.
- Kostra `docs/archive/` — README (manuál), INDEX.md (prázdná tabulka),
  4 kategorie s `.gitkeep`.

## Co se NEDĚLÁ (rozsah)

- Žádný upload server ani in-game prohlížeč — archiv je čistě git + GitHub UI.
- Žádné Git LFS (zdarma jen 1 GB a komplikuje klony) — místo toho limit velikosti.
- Žádná automatická synchronizace z iPadu — vstupním bodem je vždy Claude session.

## Možná budoucí rozšíření (až bude potřeba)

- Jednoduchý `docs/archive/viewer.html` (dev-only, mimo deploy) s galerií náhledů.
- Skript, který INDEX.md generuje automaticky z názvů souborů.
