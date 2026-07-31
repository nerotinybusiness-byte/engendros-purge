# 📁 Archiv příloh (dokumenty z iPadu)

Trvalé úložiště pro dokumenty přiložené v Claude sessions — fotky, screenshoty,
PDF, poznámky. Session kontejner je jednorázový a po skončení zmizí i s
přílohami; **co je tady a pushnuté, to se už neztratí.**

Katalog všeho je v [`index.md`](./index.md) — **bez řádku v indexu sem nic
nepatří.** Design: `docs/superpowers/specs/2026-07-31-ipad-document-archive-design.md`.

## Jak uložit dokument (z iPadu)

1. V Claude session **přilož soubor do chatu**.
2. Napiš: *„ulož to do archivu"* + jednou větou k čemu to je.
3. Claude ho uloží podle konvence níže, doplní `index.md`, commitne a pushne
   na feature větvi → PR → druhý brácha schválí → merge.

## Konvence pojmenování

- Jeden soubor: `RRRR-MM-DD-kratky-popis.pripona`
  — např. `2026-07-31-naves-mapy-skica.jpeg`
- Víc souvisejících souborů: podsložka `RRRR-MM-DD-kratky-popis/`
- Popis česky, malými písmeny, bez diakritiky, slova pomlčkami.

## Pravidla

- Jen věci k projektu — **žádné osobní/citlivé dokumenty** (repo čtou oba
  bráchové a stahuje ho Vercel build).
- Soubory nad ~10 MB jen po domluvě (git si je pamatuje navždy).
- Každý přírůstek = řádek v `index.md` (datum, kdo, popis, kontext).
- Složka je v `.vercelignore` — na produkční web se nenasazuje.

## Pro Claude (příkaz do budoucích sessions)

Když se úkol týká archivu nebo dřívějších podkladů, **nejdřív si přečti
`archive/index.md`** — je to jediná trvalá paměť napříč sessions. Při ukládání
dodrž konvenci výše a vždy doplň index.
