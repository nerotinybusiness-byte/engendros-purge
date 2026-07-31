# Archiv příloh z iPadu — design (2026-07-31)

**Autor zadání:** Martin · **Stav:** navrženo + MVP implementováno (tato větev)

## Problém

Martin pracuje s Claudem hlavně z iPadu a do chatu přikládá dokumenty — fotky,
screenshoty, PDF, poznámky. Jenže session Claude Code běží v **jednorázovém
kontejneru**: jakmile session skončí, kontejner (a s ním každá nahraná příloha
i celá konverzace) zmizí. Důsledky:

- přílohy se ztrácejí — „tu fotku jsem ti přece posílal" nejde dohledat,
- ani Claude v nové session nevidí, co se v minulých sessions řešilo,
- neexistuje jedno místo, kde by oba bráchové našli podklady k projektu.

Přesně to se stalo i při zadávání tohoto úkolu: dřívější debaty o tomto
úložišti nebyly nikde zapsané, takže se k nim nešlo vrátit.

## Cíl

Trvalé, jednoduché úložiště **přímo v gitu**, kam se přílohy z chatu ukládají
na povel — s katalogem, který slouží zároveň jako **paměť** (kontext) pro
budoucí sessions i pro oba bráchy.

## Návrh (MVP — hotovo v této větvi)

### Kde: `archive/` v kořeni repa

- **Jeden dokument** → soubor `archive/RRRR-MM-DD-kratky-popis.pripona`
  (např. `2026-07-31-naves-mapy-skica.jpeg`).
- **Víc souvisejících souborů** → podsložka `archive/RRRR-MM-DD-kratky-popis/`.
- **`archive/index.md`** — katalog: tabulka (datum, soubor, kdo, popis, kontext)
  + sekce *Poznámky a historie* pro volné zápisky. GitHub ho vykreslí i na
  iPadu v Safari, takže katalog je zároveň prohlížečka — žádná appka navíc.
- **`archive/README.md`** — pravidla + přesný postup „jak z iPadu".

### Workflow z iPadu (celý point)

1. Martin v Claude session **přiloží soubor do chatu** a napíše
   „ulož to do archivu" (+ krátký popis, k čemu to je).
2. Claude soubor **zkopíruje do `archive/`** podle konvence, **doplní řádek do
   `index.md`**, commitne na feature větvi a pushne.
3. PR → druhý brácha schválí → merge. Od té chvíle je dokument trvale v repu.

Session smí zaniknout kdykoli — jakmile je push venku, nic se neztratí.

### Deploy

`archive` je přidán do `.vercelignore` — přílohy se **nenasazují** na
produkční web, žijí jen v gitu. Žádný dopad na hru, žádný cache-bust rituál.

### Pravidla

- Jen věci k projektu; **žádné osobní/citlivé dokumenty** (repo čtou oba +
  Vercel build). Velké soubory (>10 MB) jen po domluvě — git bobtná navždy.
- Každý přírůstek **musí** mít řádek v `index.md`, jinak je k nenalezení.
- Claude na začátku každého úkolu, který se k archivu vztahuje, **nejdřív čte
  `archive/index.md`** — to je ta „paměť", která dnes chyběla.

## Co MVP záměrně nemá (možné další kroky)

- **HTML prohlížečku s náhledy** (à la dev viewery) — GitHub render `index.md`
  zatím stačí; případná prohlížečka by potřebovala udržovaný `manifest.json`.
- **Upload endpoint** (à la buildgen `tools/buildgen/server.mjs`) — dává smysl
  jen na localhostu, z iPadu je cesta přes Claude session jednodušší.
- **Automatické zmenšování obrázků** — až kdyby archiv rostl moc rychle.

## Rizika

- Git není objektové úložiště — disciplína u velikostí souborů je nutná.
- Katalog žije jen díky kázni „bez řádku v indexu nic nemergovat";
  vynucení (CI check, že každý soubor v `archive/` má řádek v indexu) je
  snadný follow-up, pokud se ukáže potřeba.
