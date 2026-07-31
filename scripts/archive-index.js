#!/usr/bin/env node
// Generates archive/index.json (read by archive.html) and archive/INDEX.md
// (human-readable listing on GitHub) from the archive/*/ entry folders.
// Static hosting can't list directories, so the index must be pre-built.
//
// Usage: node scripts/archive-index.js   (run after adding/editing any entry)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'archive');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const TEXT_EXT = new Set(['.md', '.txt']);

function fileKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

function slugTitle(dirName) {
  // "2026-07-31-ukazkovy-zaznam" -> "ukazkovy zaznam"
  const rest = dirName.replace(/^\d{4}-\d{2}-\d{2}-?/, '');
  return (rest || dirName).replace(/[-_]+/g, ' ').trim();
}

function parseNote(entryDir) {
  // poznamka.md / note.md: first "# heading" = title, first plain paragraph = description
  for (const name of ['poznamka.md', 'note.md']) {
    const p = path.join(entryDir, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    let title = null;
    let desc = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('#')) {
        if (!title) title = t.replace(/^#+\s*/, '');
        continue;
      }
      desc = t;
      break;
    }
    return { title, desc, noteFile: name };
  }
  return { title: null, desc: null, noteFile: null };
}

function main() {
  if (!fs.existsSync(ARCHIVE)) {
    console.error('archive/ neexistuje — nic ke zpracování.');
    process.exit(1);
  }

  const entries = [];
  for (const name of fs.readdirSync(ARCHIVE).sort()) {
    const full = path.join(ARCHIVE, name);
    if (name.startsWith('.')) continue;
    if (!fs.statSync(full).isDirectory()) {
      if (!['README.md', 'INDEX.md', 'index.json'].includes(name)) {
        console.warn(`⚠ volný soubor archive/${name} — patří do složky YYYY-MM-DD-nazev/, přeskočeno.`);
      }
      continue;
    }

    const files = fs.readdirSync(full).sort()
      .filter((f) => !f.startsWith('.'))
      .map((f) => ({
        name: f,
        size: fs.statSync(path.join(full, f)).size,
        kind: fileKind(f),
      }));
    if (!files.length) { console.warn(`⚠ prázdná složka archive/${name}, přeskočeno.`); continue; }

    const note = parseNote(full);
    const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
    entries.push({
      dir: name,
      date: dateMatch ? dateMatch[1] : null,
      title: note.title || slugTitle(name),
      desc: note.desc,
      files,
    });
  }

  entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.dir.localeCompare(a.dir));

  const index = { generated: new Date().toISOString(), count: entries.length, entries };
  fs.writeFileSync(path.join(ARCHIVE, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
  const md = [
    '# Archiv dokumentů — přehled',
    '',
    '_Generováno skriptem `node scripts/archive-index.js` — needitovat ručně._',
    '',
    '| Datum | Záznam | Soubory |',
    '|---|---|---|',
    ...entries.map((e) => {
      const filesTxt = e.files.map((f) => `[${f.name}](./${encodeURIComponent(e.dir)}/${encodeURIComponent(f.name)}) (${kb(f.size)})`).join('<br>');
      return `| ${e.date || '—'} | **${e.title}**${e.desc ? `<br>${e.desc}` : ''} | ${filesTxt} |`;
    }),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ARCHIVE, 'INDEX.md'), md);

  console.log(`OK: ${entries.length} záznam(ů) → archive/index.json + archive/INDEX.md`);
}

main();
