// Visionneuse plein écran (planches de BD) : zoom au pincement, double-tap, molette ou boutons ; déplacement au doigt
// quand la page est zoomée ; balayage gauche/droite pour changer de page ; fermeture par ✕, Échap ou « retour ».
import { h, replace } from './dom.ts';

export interface ViewerOptions {
  /** Nombre de pages et page de départ (0..count-1). */
  count: number;
  start: number;
  title: string;
  /** Rend une page en haute définition. */
  render(index: number): Promise<HTMLCanvasElement>;
  /** Enregistre la page affichée (facultatif). */
  download?(index: number): void;
}

const MAX_ZOOM = 6;
const DOUBLE_TAP_MS = 300;

/** Ouvre la visionneuse ; renvoie une fonction qui la ferme. */
export function openViewer(opts: ViewerOptions): () => void {
  let index = Math.max(0, Math.min(opts.count - 1, opts.start));
  let canvas: HTMLCanvasElement | null = null;
  // Taille « ajustée à l'écran » de la page, puis transformation : translate(x, y) scale(s).
  let fitW = 0;
  let fitH = 0;
  let s = 1;
  let x = 0;
  let y = 0;
  let token = 0;

  const stage = h('div', { class: 'viewer-stage', 'data-testid': 'viewer-stage' });
  const counter = h('span', { class: 'viewer-count', 'data-testid': 'viewer-count' });
  const zoomLabel = h('span', { class: 'viewer-zoom', 'data-testid': 'viewer-zoom' }, '100 %');
  const btn = (label: string, aria: string, testid: string, on: () => void) =>
    h('button', { type: 'button', class: 'viewer-btn', 'aria-label': aria, title: aria, 'data-testid': testid, on: { click: (e: Event) => (e.stopPropagation(), on()) } }, label);
  const prevBtn = btn('‹', 'Page précédente', 'viewer-prev', () => go(index - 1));
  const nextBtn = btn('›', 'Page suivante', 'viewer-next', () => go(index + 1));
  const closeBtn = btn('✕', 'Fermer', 'viewer-close', () => close());
  const root = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${opts.title} — plein écran`, 'data-testid': 'page-viewer' },
    stage,
    h(
      'div',
      { class: 'viewer-bar viewer-top' },
      h('span', { class: 'viewer-title' }, opts.title),
      opts.download ? btn('⤓', 'Enregistrer cette page (PNG)', 'viewer-download', () => opts.download!(index)) : null,
      closeBtn,
    ),
    h(
      'div',
      { class: 'viewer-bar viewer-bottom' },
      prevBtn,
      counter,
      nextBtn,
      h('span', { class: 'viewer-sep' }),
      btn('−', 'Zoom arrière', 'viewer-zoom-out', () => zoomAt(s / 1.5, center())),
      zoomLabel,
      btn('+', 'Zoom avant', 'viewer-zoom-in', () => zoomAt(s * 1.5, center())),
      btn('⤢', 'Ajuster à l’écran', 'viewer-fit', () => fit()),
    ),
  );

  const center = () => ({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 });

  function apply(animate = false) {
    if (!canvas) return;
    // Bornes : la page zoomée couvre l'écran sans laisser de vide ; plus petite que l'écran, elle reste centrée.
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const w = fitW * s;
    const hh = fitH * s;
    x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, x));
    y = hh <= vh ? (vh - hh) / 2 : Math.min(0, Math.max(vh - hh, y));
    canvas.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    canvas.dataset.scale = s.toFixed(3);
    zoomLabel.textContent = `${Math.round(s * 100)} %`;
    stage.classList.toggle('zoomed', s > 1.01);
  }

  function fit(animate = true) {
    if (!canvas) return;
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const r = Math.min(vw / canvas.width, vh / canvas.height);
    fitW = canvas.width * r;
    fitH = canvas.height * r;
    canvas.style.width = `${fitW}px`;
    canvas.style.height = `${fitH}px`;
    s = 1;
    x = (vw - fitW) / 2;
    y = (vh - fitH) / 2;
    apply(animate);
  }

  /** Zoom en gardant immobile le point (px, py) de l'écran. */
  function zoomAt(next: number, p: { x: number; y: number }, animate = true) {
    const ns = Math.max(1, Math.min(MAX_ZOOM, next));
    x = p.x - ((p.x - x) * ns) / s;
    y = p.y - ((p.y - y) * ns) / s;
    s = ns;
    apply(animate);
  }

  async function go(i: number) {
    if (i < 0 || i >= opts.count) return;
    index = i;
    const my = ++token;
    counter.textContent = `${index + 1} / ${opts.count}`;
    prevBtn.toggleAttribute('disabled', index === 0);
    nextBtn.toggleAttribute('disabled', index === opts.count - 1);
    stage.classList.add('loading');
    const c = await opts.render(index);
    if (my !== token) return;
    c.className = 'viewer-page';
    c.dataset.page = String(index + 1);
    canvas = c;
    replace(stage, c);
    stage.classList.remove('loading');
    fit(false);
  }

  // ------------------------------------------------------------ gestes (pointer events : doigt, souris, stylet)
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; s: number; mid: { x: number; y: number }; x: number; y: number } | null = null;
  let drag: { x: number; y: number; ox: number; oy: number; t: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const local = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const midOf = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur synthétique */
    }
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: dist(a, b), s, mid: midOf(a, b), x, y };
      drag = null;
    } else if (pts.size === 1) {
      const p = local(e);
      drag = { x: p.x, y: p.y, ox: x, oy: y, t: Date.now() };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const m = midOf(a, b);
      const ns = Math.max(1, Math.min(MAX_ZOOM, (pinch.s * dist(a, b)) / Math.max(1, pinch.d)));
      // Le point sous les doigts reste sous les doigts (zoom + déplacement simultanés).
      x = m.x - ((pinch.mid.x - pinch.x) * ns) / pinch.s;
      y = m.y - ((pinch.mid.y - pinch.y) * ns) / pinch.s;
      s = ns;
      apply();
    } else if (drag && s > 1.01) {
      const p = local(e);
      x = drag.ox + (p.x - drag.x);
      y = drag.oy + (p.y - drag.y);
      apply();
    }
  });
  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) {
        const [q] = [...pts.values()];
        drag = { x: q.x, y: q.y, ox: x, oy: y, t: Date.now() };
      }
      return;
    }
    if (!drag) return;
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    const quick = Date.now() - drag.t < 600;
    drag = null;
    // Balayage horizontal (page non zoomée) : page suivante / précédente.
    if (s <= 1.01 && quick && Math.abs(dx) > 60 && Math.abs(dy) < 80) {
      void go(dx < 0 ? index + 1 : index - 1);
      return;
    }
    // Double-tap : zoom ×2,5 sur le point touché, ou retour à l'ajustement.
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && dist(p, lastTap) < 40) {
        if (s > 1.01) fit();
        else zoomAt(2.5, p);
        lastTap = { t: 0, x: 0, y: 0 };
      } else lastTap = { t: now, x: p.x, y: p.y };
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(s * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top }, false);
    },
    { passive: false },
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') void go(index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') void go(index - 1);
    else if (e.key === '+' || e.key === '=') zoomAt(s * 1.5, center());
    else if (e.key === '-') zoomAt(s / 1.5, center());
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  };
  const onResize = () => {
    if (!canvas) return;
    const keep = s;
    fit(false);
    if (keep > 1.01) zoomAt(keep, center(), false);
  };

  // « Retour » du téléphone : ferme la visionneuse au lieu de quitter l'application.
  let closed = false;
  const onPop = () => close(true);
  history.pushState({ viewer: true }, '');
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.body.append(root);
  // Vrai plein écran si le navigateur le permet (pas sur iPhone : la visionneuse occupe alors toute la fenêtre).
  if (root.requestFullscreen && document.fullscreenEnabled) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  closeBtn.focus();
  void go(index);

  function close(fromHistory = false) {
    if (closed) return;
    closed = true;
    token++;
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.body.style.overflow = prevOverflow;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    root.remove();
    if (!fromHistory && history.state?.viewer) history.back();
  }
  return () => close();
}
