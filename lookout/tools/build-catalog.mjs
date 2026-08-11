#!/usr/bin/env node
/**
 * Turn a Reseller Brand Guide (.docx) into the catalog the extension classifies against.
 *
 * The guide is the product knowledge. It is written and maintained in Word, and it is
 * revised often — the men's guide is on v24 — so this is a converter rather than a
 * one-time transcription. Re-run it when a new revision lands and the extension picks up
 * the change; nobody hand-edits JSON.
 *
 *   node tools/build-catalog.mjs ~/Downloads/Mens_Shoe_Reseller_AZ_Guide_v24.docx men-shoes
 *
 * THE THREE TIERS, which are the whole point:
 *
 *   master     The label alone is the reason to inspect. ~170 shoe + ~36 boot brands.
 *   exception  A brand common enough to be worthless by default, where specific models,
 *              lines, vintages or collaborations are worth picking up. Nike is here:
 *              Nike Revolution is landfill, Nike SB Dunk is not.
 *   (absent)   Everything else. Faded Glory, U.S. Polo Assn. Not stored — "not in the
 *              catalog" IS the verdict, and storing the world's common brands to say so
 *              would be a list nobody could maintain.
 *
 * No dependencies, including for the .docx itself — see readZipEntry. A build tool that
 * needs `npm install` before a guide can be re-imported is a build tool that rots.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ docx = zip */

/**
 * Pull one file out of a zip by name, reading the central directory.
 *
 * A .docx is a zip holding word/document.xml. Node ships inflate but not a zip reader,
 * and pulling in a package to read one entry from one file is not worth the dependency.
 */
function readZipEntry(zipPath, entryName) {
  const buf = readFileSync(zipPath);

  // End of central directory: signature 0x06054b50, within the last 64KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipPath} is not a zip file`);

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (name === entryName) {
      // The local header repeats the name/extra lengths, and they can differ from the
      // central directory's, so the data offset must be read from the local header.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8');
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${entryName} not found in ${zipPath}`);
}

/** document.xml -> paragraphs, each tagged with whether Word styled it as a heading. */
function paragraphs(xml) {
  return xml
    .split(/<\/w:p>/)
    .map((block) => ({
      heading: /<w:pStyle w:val="(?:Heading\d|Title)"/.test(block),
      text: decode(block.replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).trim(),
    }))
    .filter((p) => p.text);
}

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

/* --------------------------------------------------------------- normalisation */

/** The form brand names and titles are compared in. Must match lib/normalise.js. */
export function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // Zegna's accents, Enzo Bonafè's grave
    .replace(/[’'`]/g, '')               // Church's -> churchs, so "Churchs" matches too
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The strings a brand can appear as in a listing title.
 *
 * The guide writes canonical names, but sellers do not. "A Bathing Ape (BAPE)" is listed
 * as BAPE far more often than in full, and "AGL (Attilio Giusti Leombruni)" is never
 * spelled out. A parenthesised part is therefore its own alias, not decoration.
 */
function aliasesFor(name) {
  const out = new Set();
  const paren = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const base = paren ? paren[1] : name;

  out.add(normalise(base));
  if (paren) out.add(normalise(paren[2]));

  // "Dingo, Durango and Laredo" is three brands sharing one rule, as is "Eastland,
  // Sebago and Sperry" and "Demonia and T.U.K.".
  for (const part of base.split(/,| and (?=[A-Z])/)) {
    const piece = normalise(part);
    if (piece && piece.split(' ').length <= 4) out.add(piece);
  }

  // "Ralph Lauren/Polo Ralph Lauren" and "Cody James and Cinch Edge".
  for (const part of base.split('/')) out.add(normalise(part));

  // A trailing category word is not part of the brand: sellers write "Carhartt boots",
  // not "Carhartt footwear boots".
  for (const alias of [...out]) {
    const trimmed = alias.replace(/\s+(footwear|boots|shoes)$/, '');
    if (trimmed) out.add(trimmed);
  }

  return [...out].filter((a) => a && a.length >= 2);
}

/* ------------------------------------------------------------------ exceptions */

/* Words that qualify a model rather than name one. "premium Terrex" is a Terrex hit;
   "premium" alone is not a model and must never become a matchable token, or every
   listing using the word "premium" in its title would pass. */
const QUALIFIERS = new Set([
  'premium', 'rare', 'vintage', 'only', 'models', 'model', 'line', 'lines', 'series',
  'and', 'or', 'the', 'higher', 'end', 'high', 'distinctive', 'limited', 'unusual',
  'discontinued', 'collectible', 'specialty', 'excellent', 'condition', 'older',
  'newer', 'current', 'signature', 'certain', 'various', 'at', 'a', 'low', 'buy',
  'price', 'in', 'with', 'made', 'era', 'style', 'styles', 'releases', 'release',
  // Use-categories, stripped from the ENDS of a token. "Nano training" is the Nano;
  // "premium signature basketball" is not a model at all. Deliberately excludes
  // boot/boots/shoe/shoes, because Desert Boot and Bean Boots need that word.
  'training', 'performance', 'technical', 'riding', 'hunting', 'cycling',
  'tactical', 'combat', 'military', 'winter', 'skate', 'golf', 'work', 'safety',
]);

/**
 * Single words that name a USE, not a model. A title reading "Adidas Basketball Shoes"
 * must not satisfy Adidas's rule — the guide asks for *premium signature* basketball,
 * which is a judgement no token can carry. Left unfiltered these are the highest-volume
 * false positives in the catalog, because every listing in the category contains them.
 */
const GENERIC_MODELS = new Set([
  'basketball', 'soccer', 'running', 'dress', 'hiking', 'leather', 'western',
  'sneakers', 'trainers', 'casual', 'athletic', 'sandals', 'loafers', 'oxfords',
  // Provenance, which is a SIGNAL and already captured as one. Splitting
  // "USA/UK-made" leaves a bare "usa" behind, and as a model token it would treat
  // any title mentioning the country as a confirmed model hit — promoting weak
  // evidence to strong.
  'usa', 'uk', 'england', 'britain', 'italy', 'italian', 'japan', 'america', 'american',
]);

/* Signals that are real but cannot be matched as a model name. They describe provenance
   or construction, so they are matched against the title by their own patterns rather
   than as literal tokens. Kept separate from model tokens because they are WEAKER
   evidence — "vintage" in a title is a seller's opinion. */
const SIGNAL_PATTERNS = {
  collaboration: /\b(?:collab(?:oration)?s?|\bx\b)\b/i,
  vintage: /\bvintage|\bvtg\b|\bretro\b/i,
  usaMade: /\b(?:made in (?:the )?usa|usa[- ]made|union made)\b/i,
  ukMade: /\b(?:made in (?:england|uk|britain)|england[- ]made)\b/i,
  italyMade: /\b(?:made in italy|italian[- ]made)\b/i,
  exoticLeather: /\b(?:ostrich|caiman|alligator|crocodile|lizard|elephant|stingray|python)\b/i,
  goreTex: /\bgore[- ]?tex\b/i,
};

const SIGNAL_WORDS = [
  [/\bcollaborat|collab\b/i, 'collaboration'],
  [/\bvintage\b/i, 'vintage'],
  [/\busa[- ]made|made in (?:the )?usa|us[- ]made\b/i, 'usaMade'],
  [/\bengland[- ]made|made in england|uk[- ]made\b/i, 'ukMade'],
  [/\bitalian[- ]made|italy[- ]made|made in italy\b/i, 'italyMade'],
  [/\bexotic\b|\bostrich\b|\bcaiman\b|\balligator\b|\blizard\b|\belephant\b|\bstingray\b/i, 'exoticLeather'],
  [/\bgore[- ]?tex\b/i, 'goreTex'],
];

/**
 * Split an exception's rule text into matchable model tokens and provenance signals.
 *
 * "Nike — Jordan, SB Dunk, Kobe, Foamposite, rare Air Max, ACG and collaborations"
 *   models:  jordan, sb dunk, kobe, foamposite, air max, acg
 *   signals: collaboration
 */
function parseRule(rule) {
  const models = new Set();
  const signals = new Set();

  // The guide compresses two provenances into one phrase — "USA/UK-made" — and a
  // pattern looking for "usa-made" does not see it. Expand before testing, or New
  // Balance loses its USA signal and a Made-in-USA 990 reads as an ordinary Sunday
  // trainer.
  const expanded = rule.replace(/\b([A-Za-z.]+)\/([A-Za-z.]+)-made\b/gi, '$1-made $2-made');
  for (const [pattern, signal] of SIGNAL_WORDS) {
    if (pattern.test(expanded)) signals.add(signal);
  }

  // Split on commas, on " and " before a new name, and on the slash the guide uses for
  // two names of one thing ("Polo Country/Rancourt-made", "Aristocraft/Crown Aristocraft").
  for (let part of rule.split(/,|\/| and (?![A-Z]?[a-z]*-)/)) {
    part = part.replace(/\bonly\b/gi, '').trim();
    // Strip qualifiers from both ends: "rare Air Max" -> "Air Max",
    // "Nano training" -> "Nano".
    const words = part.split(/\s+/).filter(Boolean);
    while (words.length && QUALIFIERS.has(normalise(words[0]))) words.shift();
    while (words.length && QUALIFIERS.has(normalise(words[words.length - 1]))) words.pop();
    const token = normalise(words.join(' '));
    if (!token) continue;
    // A "model" of one very short or purely qualitative word is noise.
    if (token.length < 3) continue;
    if (token.split(' ').every((w) => QUALIFIERS.has(w))) continue;
    if (SIGNAL_WORDS.some(([p]) => p.test(token))) continue;
    if (token.split(' ').length > 5) continue;
    // A bare use-category matches every listing in the category.
    if (!token.includes(' ') && GENERIC_MODELS.has(token)) continue;

    // "99x series" is a family, not a model. Written literally it can never match a
    // title, so expand it: New Balance 990 through 999.
    const family = token.match(/^(\d+)x$/);
    if (family) {
      for (let d = 0; d <= 9; d += 1) models.add(`${family[1]}${d}`);
      continue;
    }
    models.add(token);
  }

  return { models: [...models], signals: [...signals] };
}

/* ------------------------------------------------------------------------ main */

const [, , docxPath, scopeArg] = process.argv;
if (!docxPath) {
  console.error('usage: build-catalog.mjs <guide.docx> [scope]');
  process.exit(2);
}
const scope = scopeArg || 'men-shoes';

const paras = paragraphs(readZipEntry(resolve(docxPath.replace(/^~/, process.env.HOME)), 'word/document.xml'));

let section = null;
const master = new Map();      // normalised alias -> canonical name
const exceptions = new Map();  // canonical name -> { aliases, models, signals, rule }
const notes = [];
let title = '';

for (const { heading, text } of paras) {
  if (heading) {
    if (/master.*shoe brands/i.test(text)) section = 'master-shoe';
    else if (/master.*boot brands/i.test(text)) section = 'master-boot';
    else if (/exceptions/i.test(text)) section = 'exception';
    else if (/^(men|women)/i.test(text)) { title = text; section = null; }
    else section = null;
    continue;
  }

  if (section === 'master-shoe' || section === 'master-boot') {
    const kind = section === 'master-boot' ? 'boot' : 'shoe';
    master.set(text, { name: text, kind, aliases: aliasesFor(text) });
    continue;
  }

  if (section === 'exception') {
    const split = text.split(/\s+[—–]\s+/);
    if (split.length < 2) { notes.push(text); continue; }
    const [name, ...rest] = split;
    const rule = rest.join(' — ');
    const { models, signals } = parseRule(rule);
    exceptions.set(name, { name, aliases: aliasesFor(name), models, signals, rule });
  }
}

const catalog = {
  scope,
  title,
  source: docxPath.split('/').pop(),
  generatedFrom: 'tools/build-catalog.mjs',
  master: [...master.values()],
  exceptions: [...exceptions.values()],
  notes,
};

mkdirSync(resolve(ROOT, 'catalog'), { recursive: true });
const out = resolve(ROOT, 'catalog', `${scope}.json`);
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);

const noModels = catalog.exceptions.filter((e) => !e.models.length && !e.signals.length);
console.log(`${scope}: ${catalog.master.length} master (${catalog.master.filter((m) => m.kind === 'boot').length} boot), ${catalog.exceptions.length} exceptions`);
if (noModels.length) {
  console.log(`  ${noModels.length} exception(s) yielded no matchable model or signal — they can only ever be "model required":`);
  for (const e of noModels.slice(0, 8)) console.log(`    ${e.name} — ${e.rule}`);
}
console.log(`  -> ${out}`);
