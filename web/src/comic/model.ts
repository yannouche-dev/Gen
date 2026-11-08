// Studio BD : modèle de données, gabarits de page, styles, construction des prompts (FLUX.2 et Qwen 3.5).
// Module pur (sans DOM) : testé unitairement.

export type BubbleKind = 'speech' | 'thought' | 'caption';

export interface Bubble {
  id: string;
  kind: BubbleKind;
  speaker?: string;
  text: string;
  /** Position du centre de la bulle, relative à la case (0..1). */
  x: number;
  y: number;
}

export interface Panel {
  id: string;
  /** Ce qu'on voit dans la case (décrit pour le dessinateur ; anglais ou français). */
  description: string;
  /** Identifiants des personnages présents (leurs images de référence sont envoyées au modèle). */
  characters: string[];
  shot: string;
  bubbles: Bubble[];
  /** Décor (identifiant) : son image de référence est envoyée au modèle. */
  setting?: string;
  imageId?: string;
  seed?: number;
  status?: 'empty' | 'running' | 'done' | 'error';
  error?: string;
}

export interface Page {
  id: string;
  layout: string;
  panels: Panel[];
}

export interface Character {
  id: string;
  name: string;
  description: string;
  imageIds: string[];
}

/** Décor récurrent (librairie, appartement…) : une image de référence garantit sa cohérence. */
export interface Setting {
  id: string;
  name: string;
  description: string;
  imageIds: string[];
}

export interface ComicStyle {
  preset: string;
  extra: string;
  refImageId?: string;
  /** FLUX.2 « Turbo » (8 étapes) : plus rapide ; décoché, 20 étapes pour la qualité finale. */
  turbo: boolean;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  synopsis: string;
  characters: Character[];
  settings: Setting[];
  style: ComicStyle;
  pages: Page[];
  /** Résumé page par page (bible de l'histoire), pour la continuité du découpage. */
  outline?: string[];
  tone?: string;
  /** Seed de base du projet : cases reproductibles. */
  seed?: number;
}

/** Projets créés avant l'ajout des décors : champs manquants complétés. */
export function normalizeProject(p: Project): Project {
  p.settings ??= [];
  p.characters ??= [];
  p.pages ??= [];
  return p;
}

export function uid(prefix = 'x'): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${prefix}${a[0].toString(36)}${a[1].toString(36)}`;
}

export function newProject(title: string): Project {
  const now = Date.now();
  return {
    id: uid('p'),
    title,
    createdAt: now,
    updatedAt: now,
    synopsis: '',
    characters: [],
    settings: [],
    style: { preset: 'franco-belge', extra: '', turbo: true },
    pages: [],
  };
}

export function newPanel(): Panel {
  return { id: uid('c'), description: '', characters: [], shot: 'medium', bubbles: [], status: 'empty' };
}

// ------------------------------------------------------------------ styles

export interface StylePreset {
  id: string;
  label: string;
  prompt: string;
}

export const STYLES: StylePreset[] = [
  { id: 'franco-belge', label: 'Franco-belge, ligne claire', prompt: 'Franco-Belgian comic art, ligne claire style, clean uniform ink outlines, flat bright colors, detailed backgrounds' },
  { id: 'manga', label: 'Manga noir et blanc', prompt: 'black and white manga illustration, screentone shading, expressive ink linework, dynamic composition' },
  { id: 'comics-us', label: 'Comics américain', prompt: 'American superhero comic book art, bold inking, dramatic shadows, vibrant halftone colors' },
  { id: 'webtoon', label: 'Webtoon couleur', prompt: 'Korean webtoon style digital illustration, soft cel shading, clean lines, luminous colors' },
  { id: 'aquarelle', label: 'Aquarelle', prompt: 'watercolor comic illustration, delicate ink lines, soft washes of color, textured paper' },
  { id: 'polar', label: 'Polar noir et blanc', prompt: 'noir graphic novel, high-contrast black and white ink, heavy shadows, rain and city lights' },
  { id: 'cartoon', label: 'Cartoon jeunesse', prompt: 'friendly cartoon style for children, rounded shapes, thick outlines, cheerful saturated colors' },
  { id: 'realiste', label: 'BD réaliste peinte', prompt: 'realistic painted graphic novel art, detailed rendering, cinematic lighting, rich colors' },
];

export const TONES: [string, string][] = [
  ['comédie', 'Comédie'],
  ['comédie romantique', 'Comédie romantique'],
  ['vaudeville', 'Vaudeville'],
  ['aventure', 'Aventure'],
  ['polar', 'Polar'],
  ['fantastique', 'Fantastique'],
  ['science-fiction', 'Science-fiction'],
  ['drame', 'Drame'],
  ['jeunesse', 'Jeunesse'],
];

export const SHOTS: [string, string][] = [
  ['wide', 'Plan large'],
  ['medium', 'Plan moyen'],
  ['close-up', 'Gros plan'],
  ['extreme close-up', 'Très gros plan'],
  ['over-the-shoulder', 'Par-dessus l’épaule'],
  ['low angle', 'Contre-plongée'],
  ['high angle', 'Plongée'],
  ['bird’s-eye view', 'Vue de dessus'],
];

// ------------------------------------------------------------------ gabarits de page

export const PAGE_W = 1654; // A4 à 200 dpi
export const PAGE_H = 2339;
export const MARGIN = 70;
export const GUTTER = 28;

export interface Layout {
  id: string;
  label: string;
  /** Lignes : poids de hauteur et poids des cases de la ligne. */
  rows: { h: number; cells: number[] }[];
}

export const LAYOUTS: Layout[] = [
  { id: 'p1', label: 'Pleine page', rows: [{ h: 1, cells: [1] }] },
  { id: 'b2', label: '2 bandes', rows: [{ h: 1, cells: [1] }, { h: 1, cells: [1] }] },
  { id: 'm3', label: '1 grande + 2', rows: [{ h: 1.2, cells: [1] }, { h: 1, cells: [1, 1] }] },
  { id: 'b3', label: '3 bandes', rows: [{ h: 1, cells: [1] }, { h: 1, cells: [1] }, { h: 1, cells: [1] }] },
  { id: 'g4', label: '4 cases', rows: [{ h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }] },
  { id: 'm4', label: '1 bande + 3', rows: [{ h: 1, cells: [1] }, { h: 1, cells: [1.3, 1] }, { h: 1, cells: [1] }] },
  { id: 'm5', label: '1 + 2 + 2', rows: [{ h: 1, cells: [1] }, { h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }] },
  { id: 'g6', label: 'Gaufrier 6', rows: [{ h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }] },
];

export function layoutCount(l: Layout): number {
  return l.rows.reduce((n, r) => n + r.cells.length, 0);
}

export function layoutFor(count: number): Layout {
  return LAYOUTS.find((l) => layoutCount(l) === count) ?? (count > 6 ? LAYOUTS.find((l) => l.id === 'g6')! : LAYOUTS[0]);
}

export function getLayout(id: string): Layout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangles des cases d'une page (en pixels de page). */
export function cellRects(layout: Layout): Rect[] {
  const innerW = PAGE_W - 2 * MARGIN;
  const innerH = PAGE_H - 2 * MARGIN;
  const totalH = layout.rows.reduce((n, r) => n + r.h, 0);
  const usableH = innerH - GUTTER * (layout.rows.length - 1);
  const rects: Rect[] = [];
  let y = MARGIN;
  for (const row of layout.rows) {
    const rh = (usableH * row.h) / totalH;
    const totalW = row.cells.reduce((n, c) => n + c, 0);
    const usableW = innerW - GUTTER * (row.cells.length - 1);
    let x = MARGIN;
    for (const c of row.cells) {
      const cw = (usableW * c) / totalW;
      rects.push({ x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(rh) });
      x += cw + GUTTER;
    }
    y += rh + GUTTER;
  }
  return rects;
}

/** Taille de génération pour une case : ≈ 1 mégapixel au format de la case, multiple de 16. */
export function generationSize(cell: Rect, megapixels = 1): { width: number; height: number } {
  const r = cell.w / cell.h;
  const px = megapixels * 1_000_000;
  const round = (v: number) => Math.max(512, Math.min(2048, Math.round(v / 16) * 16));
  return { width: round(Math.sqrt(px * r)), height: round(Math.sqrt(px / r)) };
}

// ------------------------------------------------------------------ prompts

export interface RefPlan {
  /** Images envoyées au modèle, dans l'ordre des « reference image N ». */
  images: string[];
  prompt: string;
}

/**
 * Prompt d'une case pour FLUX.2 (références multiples). Les personnages présents sont décrits et reliés à
 * leur image de référence ; l'image de style éventuelle passe en dernier. Pas de texte dans l'image :
 * les bulles sont ajoutées par l'interface.
 */
export function panelPrompt(p: Project, panel: Panel, maxRefs = 4): RefPlan {
  const style = STYLES.find((s) => s.id === p.style.preset);
  const images: string[] = [];
  const lines: string[] = [];
  lines.push(`${style?.prompt ?? ''}${p.style.extra ? ', ' + p.style.extra : ''}.`);
  lines.push(`Single comic book panel, ${panel.shot} shot. ${panel.description.trim()}`);
  const chars = panel.characters.map((id) => p.characters.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const setting = panel.setting ? (p.settings ?? []).find((x) => x.id === panel.setting) : undefined;
  const slots = maxRefs - (p.style.refImageId ? 1 : 0);
  // Ordre : 1re image de chaque personnage, image du décor, puis autres images des personnages, s'il reste de la place.
  const refsOf = new Map<string, number[]>(chars.map((c) => [c.id, []]));
  const take = (c: Character, k: number) => {
    const img = c.imageIds[k];
    if (img && images.length < slots) {
      images.push(img);
      refsOf.get(c.id)!.push(images.length);
    }
  };
  for (const c of chars) take(c, 0);
  let settingRef = 0;
  if (setting?.imageIds[0] && images.length < slots) {
    images.push(setting.imageIds[0]);
    settingRef = images.length;
  }
  const depth = Math.max(0, ...chars.map((c) => c.imageIds.length));
  for (let k = 1; k < depth; k++) for (const c of chars) take(c, k);
  const list = (n: number[]) => (n.length === 1 ? `reference image ${n[0]}` : `reference images ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
  for (const c of chars) {
    const nums = refsOf.get(c.id)!;
    if (nums.length) {
      lines.push(`${c.name} is the character shown in ${list(nums)}${c.description ? ': ' + c.description.trim() : ''}. Keep ${c.name}'s face, hair, body and outfit exactly consistent with ${nums.length > 1 ? 'those references' : 'that reference'}.`);
    } else if (c.description) {
      lines.push(`${c.name}: ${c.description.trim()}`);
    }
  }
  if (setting) {
    lines.push(
      settingRef
        ? `The scene takes place in ${setting.name}, shown in reference image ${settingRef}${setting.description ? ': ' + setting.description.trim() : ''}. Keep its architecture, furniture, colors and lighting consistent with that reference.`
        : `Setting: ${setting.name}${setting.description ? ': ' + setting.description.trim() : ''}.`,
    );
  }
  if (p.style.refImageId) {
    images.push(p.style.refImageId);
    lines.push(`Match the drawing style, line work, shading and color palette of reference image ${images.length}, but not its content.`);
  }
  lines.push('No text, no letters, no speech bubbles, no captions, no signature, no border.');
  return { images, prompt: lines.join('\n') };
}

/**
 * Planche de poses d'un personnage (renforce la cohérence : ajoutée comme image de référence).
 * Avec une photo : « le même personnage que l'image 1 » ; sans photo : dessiné d'après sa description.
 */
export function turnaroundPrompt(p: Project, c: Character, withRef = true): string {
  const style = STYLES.find((s) => s.id === p.style.preset);
  const desc = c.description.trim();
  return [
    withRef
      ? `Character reference sheet of ${c.name}, the exact same character as in reference image 1${desc ? ' (' + desc + ')' : ''}.`
      : `Character reference sheet of ${c.name}: ${desc || 'a comic book character'}.`,
    'Show four full-body views side by side: front view, three-quarter view, side profile, back view, plus a close-up of the face.',
    'Neutral standing pose, identical outfit and proportions in every view, plain white background.',
    `${style?.prompt ?? ''}${p.style.extra ? ', ' + p.style.extra : ''}.`,
    'No text, no labels.',
  ].join('\n');
}

/** Image de référence d'un décor : plan d'ensemble, sans personnage. */
export function settingPrompt(p: Project, s: Setting): string {
  const style = STYLES.find((x) => x.id === p.style.preset);
  return [
    `Establishing shot of ${s.name}: ${s.description.trim() || s.name}.`,
    'Wide view showing the whole place, its architecture, furniture, colors and lighting. Empty scene, no people.',
    `${style?.prompt ?? ''}${p.style.extra ? ', ' + p.style.extra : ''}.`,
    'No text, no letters, no signs with writing, no border.',
  ].join('\n');
}

export const SHEET_SIZE = { width: 1536, height: 864 };
export const SETTING_SIZE = { width: 1216, height: 832 };

export function describeCharacterPrompt(name: string): string {
  return (
    `Describe the character${name ? ' "' + name + '"' : ''} in this image for a comic artist who must draw them consistently on every page. ` +
    'One paragraph in English, at most 80 words: apparent age, gender, face shape, hair color and style, eye color, skin tone, build, ' +
    'clothing with colors, accessories, distinctive marks. Do not describe the background, the pose or the image style. Return only the paragraph.'
  );
}

export function storyPrompt(p: Project, pages: number): string {
  const cast = p.characters.map((c) => `- ${c.name}: ${c.description || 'no description'}`).join('\n') || '- (no named characters)';
  const places = (p.settings ?? []).map((s) => `- ${s.name}: ${s.description || 'no description'}`).join('\n');
  const style = STYLES.find((s) => s.id === p.style.preset)?.label ?? p.style.preset;
  const outline = (p.outline ?? []).map((o, i) => `Page ${i + 1}: ${o}`).join('\n');
  return [
    'You are an experienced comic book writer and storyboard artist.',
    `Split the story below into exactly ${pages} comic page(s). Each page has between 3 and 6 panels with varied framing.`,
    `Art style: ${style}.${p.tone ? ` Tone: ${p.tone}.` : ''}`,
    'Characters (use these exact names):',
    cast,
    ...(places ? ['Settings (use these exact names):', places] : []),
    'Story:',
    p.synopsis.trim(),
    ...(outline ? ['Page-by-page outline to follow strictly:', outline] : []),
    '',
    'Continuity rules: every panel follows logically from the previous one; characters keep the same outfit, hairstyle and props unless the story changes them; time of day and weather stay consistent within a scene; the last page ends the story with a clear payoff.',
    'Keep it tasteful: romance, flirting and innuendo are fine, but no nudity and no explicit sexual content.',
    'Return ONLY valid JSON, no comments, with this exact structure:',
    '{"pages":[{"panels":[{"description":"<what is visible in the panel, in English, concrete visual details, actions, expressions, lighting; no text>",' +
      '"characters":["<names present>"],' +
      (places ? '"setting":"<one setting name>",' : '') +
      '"shot":"<wide|medium|close-up|extreme close-up|over-the-shoulder|low angle|high angle|bird’s-eye view>",' +
      '"dialogues":[{"speaker":"<name>","text":"<line in French>"}],"caption":"<short French narration or empty string>"}]}]}',
    'Dialogues and captions must be in French, short (at most 20 words each), at most 2 dialogues per panel.',
  ].join('\n');
}

/** Retire le raisonnement éventuel (<think>…</think>) et les balises de code avant de lire le JSON. */
function jsonBlock(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Réponse sans JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ------------------------------------------------------------------ BD express : bible de l'histoire

export interface Bible {
  synopsis: string;
  pages: string[];
  characters: { name: string; description: string }[];
  settings: { name: string; description: string }[];
}

/** Demande à l'IA la « bible » d'une BD à partir d'un simple titre : intrigue page par page, personnages, décors. */
export function biblePrompt(p: Project, title: string, pages: number): string {
  const style = STYLES.find((s) => s.id === p.style.preset)?.label ?? p.style.preset;
  const fixed = p.characters.filter((c) => c.name.trim());
  return [
    'You are an experienced comic book writer. Write the story bible of a short comic book.',
    `Title (French): "${title}".`,
    `Length: exactly ${pages} page(s). Tone: ${p.tone || 'comédie'}. Art style: ${style}.`,
    ...(fixed.length ? ['Main characters already chosen (keep these exact names and looks; you may add at most 2 secondary characters):', ...fixed.map((c) => `- ${c.name}: ${c.description || 'no description yet'}`)] : ['Create 2 to 4 characters.']),
    'Create 1 to 3 recurring settings (places).',
    'The story must have a clear setup, a twist and a satisfying ending on the last page. Keep it tasteful: romance, flirting and innuendo are fine, but no nudity and no explicit sexual content.',
    'Return ONLY valid JSON, no comments, with this exact structure:',
    '{"synopsis":"<the whole story in French, 4 to 8 sentences>",' +
      '"pages":["<what happens on page 1, in French, 1 to 3 sentences>"],' +
      '"characters":[{"name":"<first name>","description":"<visual description in English for an illustrator: apparent age, gender, face, hair color and style, eye color, skin tone, build, outfit with colors, accessories>"}],' +
      '"settings":[{"name":"<short French name>","description":"<visual description in English: architecture, furniture, colors, lighting, time of day>"}]}',
    `The "pages" array must contain exactly ${pages} item(s).`,
  ].join('\n');
}

export function parseBible(text: string, pages: number): Bible {
  const d = jsonBlock(text) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const b: Bible = {
    synopsis: str(d.synopsis),
    pages: (Array.isArray(d.pages) ? d.pages : []).map((x) => (typeof x === 'string' ? x.trim() : str((x as Record<string, unknown>)?.summary))).filter(Boolean),
    characters: list(d.characters).map((c) => ({ name: str(c?.name), description: str(c?.description) })).filter((c) => c.name).slice(0, 6),
    settings: list(d.settings).map((c) => ({ name: str(c?.name), description: str(c?.description) })).filter((c) => c.name).slice(0, 4),
  };
  if (!b.synopsis && !b.pages.length) throw new Error('JSON sans histoire');
  if (!b.characters.length) throw new Error('JSON sans personnages');
  b.pages = b.pages.slice(0, pages);
  return b;
}

/** Applique la bible au projet : personnages existants gardés (description complétée), nouveaux ajoutés, décors remplacés. */
export function applyBible(p: Project, b: Bible): void {
  p.synopsis = b.synopsis || b.pages.join(' ');
  p.outline = b.pages;
  const key = (n: string) => n.trim().toLowerCase();
  for (const c of b.characters) {
    const cur = p.characters.find((x) => key(x.name) === key(c.name));
    if (cur) {
      if (!cur.description.trim()) cur.description = c.description;
    } else p.characters.push({ id: uid('k'), name: c.name, description: c.description, imageIds: [] });
  }
  const keep = (p.settings ?? []).filter((s) => s.imageIds.length || b.settings.some((x) => key(x.name) === key(s.name)));
  p.settings = keep;
  for (const s of b.settings) {
    const cur = p.settings.find((x) => key(x.name) === key(s.name));
    if (cur) {
      if (!cur.description.trim()) cur.description = s.description;
    } else p.settings.push({ id: uid('s'), name: s.name, description: s.description, imageIds: [] });
  }
}

export interface ParsedStory {
  pages: { panels: { description: string; characters: string[]; setting: string; shot: string; dialogues: { speaker: string; text: string }[]; caption: string }[] }[];
}

/** Lit la réponse JSON du modèle de langage, même entourée de texte ou de balises ```json. */
export function parseStory(text: string): ParsedStory {
  const data = jsonBlock(text) as { pages?: unknown };
  if (!Array.isArray(data.pages) || !data.pages.length) throw new Error('JSON sans pages');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    pages: data.pages.map((pg) => {
      const panels = Array.isArray((pg as { panels?: unknown }).panels) ? ((pg as { panels: unknown[] }).panels) : [];
      return {
        panels: panels.slice(0, 6).map((raw) => {
          const r = raw as Record<string, unknown>;
          return {
            description: str(r.description),
            characters: Array.isArray(r.characters) ? (r.characters as unknown[]).map(str).filter(Boolean) : [],
            setting: str(r.setting),
            shot: SHOTS.some(([k]) => k === r.shot) ? str(r.shot) : 'medium',
            dialogues: Array.isArray(r.dialogues)
              ? (r.dialogues as Record<string, unknown>[]).slice(0, 3).map((d) => ({ speaker: str(d?.speaker), text: str(d?.text) })).filter((d) => d.text)
              : [],
            caption: str(r.caption),
          };
        }),
      };
    }).filter((pg) => pg.panels.length > 0),
  };
}

/** Bulles par défaut d'une case : récitatif en haut à gauche, répliques en haut, en alternance. */
export function defaultBubbles(dialogues: { speaker: string; text: string }[], caption: string): Bubble[] {
  const out: Bubble[] = [];
  if (caption.trim()) out.push({ id: uid('b'), kind: 'caption', text: caption.trim(), x: 0.3, y: 0.1 });
  dialogues.forEach((d, i) => {
    out.push({ id: uid('b'), kind: 'speech', speaker: d.speaker, text: d.text, x: i % 2 ? 0.7 : 0.32, y: (caption.trim() ? 0.3 : 0.16) + 0.18 * i });
  });
  return out;
}

/** Convertit le découpage proposé par l'IA en pages du projet (personnages reliés par leur nom). */
export function storyToPages(p: Project, story: ParsedStory): Page[] {
  return story.pages.map((pg) => {
    const panels: Panel[] = pg.panels.map((pa) => ({
      ...newPanel(),
      description: pa.description,
      shot: pa.shot,
      characters: pa.characters
        .map((name) => p.characters.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase())?.id)
        .filter((x): x is string => !!x),
      setting: (p.settings ?? []).find((s) => s.name.trim().toLowerCase() === pa.setting.trim().toLowerCase())?.id,
      bubbles: defaultBubbles(pa.dialogues, pa.caption),
    }));
    return { id: uid('g'), layout: layoutFor(panels.length).id, panels };
  });
}
