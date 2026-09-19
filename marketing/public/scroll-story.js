// Scroll is input, never intercepted. Pure pose math is tested independently.
export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export function progressFor(top, height, viewport) {
  return height <= viewport ? 0 : clamp(-top / (height - viewport));
}

// x/y are percentages of each plate. rx/rz are degrees; scale is unitless.
const FRAMES = [
  [ [0, 35, 56, -30, .88], [0, 12, 56, -30, .88], [0, -11, 56, -30, .88], [0, -34, 56, -30, .88] ],
  [ [7, 98, 42, -24, .86], [-4, 33, 42, -24, .86], [4, -32, 42, -24, .86], [-7, -97, 42, -24, .86] ],
  [ [-46, -52, 8, -12, .77], [46, -52, 8, 12, .77], [-46, 52, 8, -8, .77], [46, 52, 8, 8, .77] ],
  [ [-37, -37, 16, -20, .7], [37, -37, 16, 20, .7], [-37, 37, 16, -15, .7], [37, 37, 16, 15, .7] ],
];
export function sceneAt(progress, compact = false) {
  const scaled = clamp(progress) * 3;
  const from = Math.min(2, Math.floor(scaled));
  const t = scaled - from;
  // Smooth interpolation, while remaining reversible and tied to scroll position.
  const eased = t * t * (3 - 2 * t);
  const layers = FRAMES[from].map((pose, index) => pose.map((value, axis) => {
    const result = value + (FRAMES[from + 1][index][axis] - value) * eased;
    return axis === 1 && compact ? result * .66 : result;
  }));
  return { layers, chapter: Math.round(scaled), core: clamp((progress - .45) / .42) };
}

export function initScrollStory() {
  const root = document.documentElement;
  const story = document.querySelector('[data-scroll-story]');
  const layout = story?.querySelector('.story-layout');
  if (!story || !layout) return;
  const layers = [...story.querySelectorAll('[data-layer]')];
  if (layers.length !== 4) return;
  const caption = story.querySelector('[data-scene-caption]');
  const number = story.querySelector('[data-scene-number]');
  const button = story.querySelector('.motion-toggle');
  const hero = document.querySelector('.hero');
  const band = document.querySelector('.kinetic-band');
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const compact = matchMedia('(max-width: 640px)');
  const captions = [
    'One folder. A world of possibility.',
    'Give intelligence a point of view.',
    'Connect the capabilities you need.',
    'Many parts. Your agent.',
  ];
  let paused = false;
  let frame = 0;
  let chapter = -1;

  function render() {
    frame = 0;
    if (media.matches || paused) return;
    const rect = layout.getBoundingClientRect();
    const p = progressFor(rect.top, rect.height, innerHeight);
    const scene = sceneAt(p, compact.matches);
    scene.layers.forEach(([x, y, rx, rz, scale], index) => {
      layers[index].style.transform = `translate(-50%, -50%) translate(${x.toFixed(3)}%, ${y.toFixed(3)}%) rotateX(${rx.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg) scale(${scale.toFixed(3)})`;
    });
    story.style.setProperty('--story-progress', String(Math.max(.04, p)));
    story.style.setProperty('--orbit-turn', `${-25 + p * 145}deg`);
    story.style.setProperty('--core-opacity', String(scene.core));
    story.style.setProperty('--core-scale', String(.5 + scene.core * .5));
    if (chapter !== scene.chapter) {
      chapter = scene.chapter;
      story.dataset.chapter = String(chapter);
      if (caption) caption.textContent = captions[chapter];
      if (number) number.textContent = `0${chapter + 1} — 04`;
    }
    if (hero) {
      const heroRect = hero.getBoundingClientRect();
      const travel = clamp(-heroRect.top / Math.max(heroRect.height, 1));
      hero.style.setProperty('--hero-travel', `${travel * -65}px`);
      hero.style.setProperty('--hero-scale', String(1 + travel * .12));
    }
    if (band) {
      const bandRect = band.getBoundingClientRect();
      const travel = clamp((innerHeight - bandRect.top) / (innerHeight + bandRect.height));
      band.style.setProperty('--kinetic-x', `${-3 - travel * 19}%`);
    }
  }
  function schedule() {
    if (!frame && !media.matches && !paused) frame = requestAnimationFrame(render);
  }
  function applyPreference() {
    cancelAnimationFrame(frame);
    frame = 0;
    const disabled = media.matches || paused;
    root.dataset.motion = disabled ? 'off' : 'on';
    if (button) {
      button.hidden = false;
      button.disabled = media.matches;
      button.setAttribute('aria-pressed', String(disabled));
      button.textContent = media.matches ? 'Reduced motion on' : paused ? 'Resume motion' : 'Pause motion';
    }
    if (disabled) {
      layers.forEach(layer => layer.style.removeProperty('transform'));
      story.removeAttribute('style');
      hero?.style.removeProperty('--hero-travel');
      hero?.style.removeProperty('--hero-scale');
      band?.style.removeProperty('--kinetic-x');
      if (caption) caption.textContent = 'Your agent, composed from your choices.';
      if (number) number.textContent = '01 — 04';
      chapter = -1;
      delete story.dataset.chapter;
    } else {
      schedule();
    }
    root.dispatchEvent(new Event('motionpreferencechange'));
  }
  button?.addEventListener('click', () => {
    paused = !paused;
    applyPreference();
  });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  media.addEventListener('change', applyPreference);
  compact.addEventListener('change', schedule);
  // Disclosure/tab changes can alter the document height. Observe actual layout,
  // not transforms; render only on demand, never a permanent animation loop.
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(layout);
  document.fonts?.ready.then(schedule);
  applyPreference();
}
