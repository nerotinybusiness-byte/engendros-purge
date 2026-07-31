# Archiv dokumentů

Trvalé úložiště pro dokumenty přiložené do Claude sessions (typicky z iPadu) —
fotky, scany, PDF, poznámky. Session zanikne, archiv v gitu zůstane.

Plný návrh: `docs/superpowers/specs/2026-07-31-ipad-document-archive-design.md`

## Jak přidat dokument

1. Přilož soubor do session a napiš Claudovi **„ulož to do archivu"** + pár slov, o co jde.
2. Claude soubor převede (HEIC → JPG, Pages → PDF), pojmenuje a uloží sem,
   a doplní řádek do [`INDEX.md`](./INDEX.md).
3. Jde to samozřejmě i ručně — jen dodrž pravidla níže **a vždy doplň INDEX**.

## Pravidla

- **Umístění:** `docs/archive/<rok>/` — např. `docs/archive/2026/`.
  Víc souborů k jednomu tématu → podsložka `<rok>/YYYY-MM-DD-tema/`.
- **Název:** `YYYY-MM-DD-kratky-popis.pripona` — malá písmena, pomlčky, bez diakritiky.
- **Formáty:** PDF, PNG/JPG, MD. Ne HEIC, ne Pages/Numbers (převést před uložením).
- **Velikost:** cíl < 10 MB na soubor; obrázky komprimovat. Videa sem nepatří.
- **INDEX.md je povinný** — dokument bez řádku v indexu je nedohledatelný.

## Jak něco najít

- Zeptej se Clauda („co máme v archivu k …?") — čte `INDEX.md`.
- Nebo otevři [`INDEX.md`](./INDEX.md) ručně (funguje i v GitHub appce na iPadu).

Složka `docs/` je v `.vercelignore` — nic odtud se nenasazuje se hrou.
