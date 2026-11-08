// Rendu d'une planche dans le navigateur : cases (image recadrée), bordures, bulles et récitatifs.
// Le texte est dessiné ici (et non par le modèle) : accents exacts, corrigeable sans régénérer l'image.
import { cellRects, getLayout, PAGE_H, PAGE_W, type Bubble, type Page, type Rect } from './model.ts';

let fontReady: Promise<void> | null = null;
const FONT = '"Comic Neue", "Comic Sans MS", "Chalkboard SE", sans-serif';

export function ensureComicFont(): Promise<void> {
  fontReady ??= (async () => {
    try {
      for (const w of ['400', '700']) {
        const f = new FontFace('Comic Neue', `url(${new URL(`vendor/fonts/comic-neue-${w}.woff2`, document.baseURI).href})`, { weight: w });
        document.fonts.add(await f.load());
      }
    } catch {
      /* police de repli */
    }
  })();
  return fontReady;
}

export interface BubbleBox {
  bubble: Bubble;
  panelIndex: number;
  /** Boîte en pixels de page. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Typographie française : espace fine insécable avant ? ! : ; » et après «, pour ne jamais isoler la ponctuation. */
export function frenchSpacing(text: string): string {
  return text.replace(/[ \u00a0]+([?!:;»])/g, '\u202f$1').replace(/«[ \u00a0]+/g, '«\u202f');
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of frenchSpacing(text).split('\n')) {
    let cur = '';
    // Coupure aux seules espaces ordinaires (les espaces insécables restent dans le mot).
    for (const word of para.split(/[ \t]+/).filter(Boolean)) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = word;
      } else cur = test;
    }
    lines.push(cur);
  }
  return lines;
}

function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, r: Rect) {
  const s = Math.max(r.w / img.width, r.h / img.height);
  const w = img.width * s;
  const h = img.height * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
  ctx.restore();
}

/** Mesure et dessine une bulle ; renvoie sa boîte. */
function drawBubble(ctx: CanvasRenderingContext2D, b: Bubble, cell: Rect, draw: boolean): Omit<BubbleBox, 'bubble' | 'panelIndex'> {
  const size = 34;
  ctx.font = `${b.kind === 'caption' ? 400 : 700} ${size}px ${FONT}`;
  const maxW = cell.w * (b.kind === 'caption' ? 0.6 : 0.46);
  const lines = wrap(ctx, b.text || '…', maxW);
  const lineH = size * 1.18;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), size * 2);
  const padX = b.kind === 'caption' ? 18 : 30;
  const padY = b.kind === 'caption' ? 14 : 22;
  const w = textW + padX * 2;
  const h = lines.length * lineH + padY * 2;
  let x = cell.x + b.x * cell.w - w / 2;
  let y = cell.y + b.y * cell.h - h / 2;
  x = Math.max(cell.x + 8, Math.min(cell.x + cell.w - w - 8, x));
  y = Math.max(cell.y + 8, Math.min(cell.y + cell.h - h - 8, y));
  if (draw) {
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#111';
    if (b.kind === 'caption') {
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else {
      // Queue de la bulle vers le bas, en direction du centre de la case.
      const cx = x + w / 2;
      const tipX = cx + (cell.x + cell.w / 2 - cx) * 0.25;
      const tipY = Math.min(cell.y + cell.h - 10, y + h + Math.max(40, cell.h * 0.07));
      ctx.fillStyle = '#fff';
      if (b.kind === 'thought') ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.min(h / 2, 46));
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      if (b.kind === 'thought') {
        for (const [k, r] of [[0.45, 11], [0.75, 7]] as const) {
          ctx.beginPath();
          ctx.arc(cx + (tipX - cx) * k, y + h + (tipY - y - h) * k, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(cx - 18, y + h - 2);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(cx + 18, y + h - 2);
        ctx.fill();
        ctx.stroke();
        // Masque le trait de la bulle sous la base de la queue.
        ctx.fillRect(cx - 15, y + h - 6, 30, 6);
      }
    }
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'top';
    ctx.textAlign = b.kind === 'caption' ? 'left' : 'center';
    lines.forEach((l, i) => ctx.fillText(l, b.kind === 'caption' ? x + padX : x + w / 2, y + padY + i * lineH));
    ctx.restore();
  }
  return { x, y, w, h };
}

/**
 * Dessine une planche complète. `images` fournit l'image de chaque case (ou null si pas encore générée).
 * Renvoie le canvas et les boîtes des bulles (pour les déplacer au doigt).
 */
export async function renderPage(
  page: Page,
  images: (CanvasImageSource & { width: number; height: number } | null)[],
  scale = 1,
  showEmpty = true,
): Promise<{ canvas: HTMLCanvasElement; boxes: BubbleBox[] }> {
  await ensureComicFont();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * scale);
  canvas.height = Math.round(PAGE_H * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const rects = cellRects(getLayout(page.layout));
  const boxes: BubbleBox[] = [];
  page.panels.slice(0, rects.length).forEach((panel, i) => {
    const r = rects[i];
    const img = images[i];
    if (img) drawCover(ctx, img, r);
    else if (showEmpty) {
      ctx.fillStyle = '#eef0f3';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#9aa3af';
      ctx.font = `700 40px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Case ${i + 1}`, r.x + r.w / 2, r.y + r.h / 2);
    }
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#111';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    for (const b of panel.bubbles) {
      if (!b.text.trim()) continue;
      boxes.push({ bubble: b, panelIndex: i, ...drawBubble(ctx, b, r, true) });
    }
  });
  return { canvas, boxes };
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Export impossible'))), type, quality));
}
