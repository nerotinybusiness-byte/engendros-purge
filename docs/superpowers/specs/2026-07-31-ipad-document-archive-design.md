# Archiv dokumentů z iPadu — návrh (2026-07-31)

**Autor zadání:** Martin. **Stav:** navrženo + postavena F0 kostra (viz níže).

> Pozn.: v repu, issues ani PRkách žádný dřívější zápis o tomhle nápadu neexistoval.
> Nápad se probíral jen v chat sessions, které zanikly — přesně proto tenhle archiv
> vzniká. Před touto větví proběhly **4 nemergnuté pokusy** (větve
> `claude/ipad-document-storage-{45buiu,8c7gfb,a9l16r,c2b7t6}`, všechny 2026-07-31);
> tahle verze je jejich sjednocení: implementace + prohlížečka z `45buiu`,
> pravidla a „paměťová" instrukce pro Claude z `8c7gfb`. Jediný sporný bod mezi
> návrhy — **deployovat archiv na Vercel (veřejná URL, prohlížečka z iPadu), nebo
> držet jen v gitu (soukromější)** — je tu rozhodnut ve prospěch deploye, protože
> procházení z iPadu je hlavní use-case; riziko řeší pravidlo „nic citlivého".
> Staré větve jde po merge téhle smazat.

## Problém

Martin pracuje hlavně z iPadu. Do Claude sessions přikládá dokumenty — fotky,
screenshoty, PDFka, poznámky (reference ke zbraním, budovám, nápady…). Session je
ale jednorázová: po jejím konci přílohy zmizí. Chybí **trvalé úložiště („archiv")
přiložených dokumentů**, které:

1. přežije konec session (= je commitnuté v gitu),
2. jde procházet z iPadu i z počítače (= obyčejná webová stránka),
3. nevyžaduje žádný server ani build (stejná filozofie jako celá hra).

## Řešení v kostce

```
iPad → příloha v Claude session → Claude uloží do archive/<datum>-<nazev>/
     → node scripts/archive-index.js (přegeneruje index)
     → commit → PR → merge → Vercel → https://engendros-purge.vercel.app/archive.html
```

Všechno je statické — žádná databáze, žádný upload endpoint. „Uploadem" je git commit.

## Struktura v repu

```
archive/
  README.md                     ← návod (česky), jak přidat záznam
  INDEX.md                      ← generovaný přehled pro GitHub (negeneruj ručně)
  index.json                    ← generovaný index pro archive.html (negeneruj ručně)
  2026-07-31-ukazkovy-zaznam/   ← jeden záznam = jedna složka YYYY-MM-DD-nazev
    poznamka.md                 ← volitelný popis; první `# nadpis` = titulek záznamu
    foto.jpeg                   ← libovolné soubory (obrázky, PDF, txt…)
archive.html                    ← statická prohlížečka (kořen webu)
scripts/archive-index.js        ← generátor index.json + INDEX.md (Node, bez závislostí)
```

### Konvence záznamu

- **Název složky:** `YYYY-MM-DD-kratky-nazev-pomlckami` (datum přidání, ne pořízení).
- **`poznamka.md`** (volitelné): první `# nadpis` se použije jako titulek, první
  odstavec jako popis v prohlížečce. Bez něj se titulek odvodí z názvu složky.
- **Formáty:** fotky z iPadu bývají **HEIC — před uložením převést na JPEG/PNG**
  (HEIC neumí zobrazit každý prohlížeč). PDF, MD, TXT a obrázky prohlížečka
  zobrazuje/linkuje, ostatní typy nabídne ke stažení.
- **Velikost:** GitHub tvrdě odmítá soubory > 100 MB; rozumný strop na soubor je
  ~10 MB (fotky z iPadu klidně zmenšit). Archiv se deployuje na Vercel, takže
  velké soubory zpomalují každý deploy.

## Generátor (`scripts/archive-index.js`)

Statický hosting neumí vypsat obsah adresáře, proto se index generuje předem:

- projde `archive/*/`, posbírá soubory + metadata (titulek, datum, popis, velikosti),
- zapíše `archive/index.json` (čte ho `archive.html`) a `archive/INDEX.md`
  (čitelný přehled přímo na GitHubu),
- čisté Node bez závislostí: `node scripts/archive-index.js`,
- **spouští se po každém přidání/úpravě záznamu** (Claude to dělá automaticky,
  když dokument archivuje).

## Prohlížečka (`archive.html`)

- Statická stránka v kořeni (mimo hru — nesahá na `src/`, žádný cache-bust ritual).
- Načte `./archive/index.json`, vykreslí karty záznamů: titulek, datum, popis,
  náhledy obrázků (tap = plná velikost), odkazy na PDF/ostatní.
- Fulltextové filtrování (titulek, popis, názvy souborů). Česky, dark, touch-friendly.
- `vercel.json` posílá `no-store` pro `/archive.html` a `/archive/index.json`,
  aby iPad po merge viděl čerstvý seznam; samotné dokumenty se cachovat smí.

## Deploy

- `archive/` ani `archive.html` **nejsou** ve `.vercelignore` → deployují se
  (to je záměr: přístup z iPadu přes veřejnou URL).
- Netýká se herního kódu → **cache-bust ritual (`?v=N` + `GAME_BUILD`) se nedělá.**
- Pozor: URL je veřejná — nearchivovat nic citlivého (osobní doklady apod.).

## Co je hotovo (F0) a co dál

**Hotovo v této větvi:** struktura `archive/` + README, generátor, prohlížečka,
ukázkový záznam, `vercel.json` hlavičky.

**Nápady na později (až se to osvědčí):**
- štítky/tagy v `poznamka.md` (front-matter) + filtr podle tagu,
- náhledy PDF (první strana), fulltext z MD/TXT souborů,
- odkaz „Archiv" z menu hry nebo z admin obrazovky,
- GitHub Action, která index přegeneruje automaticky, když ho někdo zapomene.
