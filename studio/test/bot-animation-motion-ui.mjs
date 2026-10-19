import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const renderer = new URL('../renderer/', import.meta.url);
export default async function (page) {
  await page.setContent('<html><head><title>Bot motion QA</title></head><body></body></html>');
  await page.addStyleTag({ content: await fs.readFile(new URL('styles.css', renderer), 'utf8') });
  await page.addScriptTag({ content: await fs.readFile(new URL('member-designs.js', renderer), 'utf8') });
  await page.addStyleTag({ content: 'body { display:block; height:auto; overflow:visible; } body > svg { position:absolute; left:20px; top:20px; display:block; width:32px; height:32px; }' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Script injection runs in the main world; DOM-only evaluation also works with isolated browser drivers.
  await page.addScriptTag({ content: `
    (() => {
      const d = ReachMemberDesigns;
      const base = d.config('bot-01');
      for (const animation of d.choices.animation.filter(a => a !== 'none')) {
        for (const shape of d.choices.shape) for (const top of d.choices.top) {
          const node = document.createElement('div');
          node.innerHTML = d.svg(d.encode({...base, animation, shape, top}), 32);
          node.firstChild.dataset.variant = shape + '/' + top;
          document.body.append(node.firstChild);
        }
      }
    })();
  ` });
  const samples = await page.locator('svg').evaluateAll(svgs => {
    const failures = [];
    let sampled = 0;
    for (const svg of svgs) {
      const animations = svg.getAnimations({ subtree: true });
      animations.forEach(a => a.pause());
      const duration = animations[0].effect.getTiming().duration;
      for (let frame = 0; frame <= 40; frame++) {
        animations.forEach(a => { a.currentTime = duration * frame / 40; });
        const bounds = svg.getBoundingClientRect();
        for (const part of svg.querySelectorAll('.bot-body path, .bot-body rect, .bot-body circle, .bot-body line')) {
          const b = part.getBBox();
          const m = part.getScreenCTM();
          const stroke = getComputedStyle(part).stroke === 'none' ? 0 : Number.parseFloat(getComputedStyle(part).strokeWidth) / 2;
          const corners = [[b.x-stroke,b.y-stroke],[b.x+b.width+stroke,b.y-stroke],[b.x-stroke,b.y+b.height+stroke],[b.x+b.width+stroke,b.y+b.height+stroke]];
          const outside = corners.some(([x,y]) => {
            const p = new DOMPoint(x,y).matrixTransform(m);
            return p.x < bounds.left + .25 || p.y < bounds.top + .25 || p.x > bounds.right - .25 || p.y > bounds.bottom - .25;
          });
          if (outside && failures.length < 30) failures.push({ animation: svg.dataset.animation, variant: svg.dataset.variant, frame });
        }
        sampled++;
      }
    }
    return { sampled, variants: svgs.length, failures };
  });
  assert.deepEqual(samples.failures, [], JSON.stringify(samples.failures));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.bot-motion-frame').first().evaluate(el => getComputedStyle(el).transform), 'none');
  assert.equal(await page.locator('svg').evaluateAll(svgs => svgs.reduce((n, s) => n + s.getAnimations({ subtree: true }).length, 0)), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addScriptTag({ content: `
    document.body.replaceChildren();
    for (const [animation, part] of [['antenna','top'],['chatter','mouth']]) {
      const fixture=document.createElement('div');
      fixture.innerHTML=ReachMemberDesigns.svg(ReachMemberDesigns.encode({...ReachMemberDesigns.config('bot-01'),animation,[part]:'none'}));
      document.body.append(fixture);
    }
  ` });
  const fallbacks = await page.locator('.bot-part-fallback').evaluateAll(parts => parts.map(el => getComputedStyle(el).animationName));
  assert.deepEqual(fallbacks, ['bot-wobble','bot-nod']);
  await page.addScriptTag({ content: `
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:24px;display:grid;grid-template-columns:repeat(5,1fr);gap:12px;background:#11140f;color:#e4e8da;font:13px Georgia';
    for (const animation of ReachMemberDesigns.choices.animation.filter(a=>a!=='none')) {
      const tile=document.createElement('section');
      tile.style.cssText='padding:12px;border:1px solid #394132;border-radius:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap';
      for (const size of [32,64,96]) tile.innerHTML += ReachMemberDesigns.svg(ReachMemberDesigns.encode({...ReachMemberDesigns.config('bot-01'),animation}),size);
      const label=document.createElement('strong'); label.textContent=animation; label.style.width='100%';tile.append(label);document.body.append(tile);
    }
  ` });
  await page.setViewportSize({ width: 1400, height: 1050 });
  const motion = await page.locator('svg').evaluateAll(svgs => {
    const result = [];
    for (const svg of svgs) {
      const animations = svg.getAnimations({ subtree: true });
      const a = animations[0];
      a.pause();
      const duration = a.effect.getTiming().duration;
      const transforms = new Set();
      for (const fraction of [0,.12,.26,.41,.5,.68,.84]) {
        a.currentTime = duration * fraction;
        transforms.add(getComputedStyle(a.effect.target).transform);
      }
      result.push({ name: svg.dataset.animation, size: svg.getAttribute('width'), distinct: transforms.size });
      a.currentTime = duration * .41;
    }
    return result;
  });
  assert.ok(motion.every(m => m.distinct > 1), JSON.stringify(motion.filter(m => m.distinct <= 1)));
  return { ...samples, animatedSizes: [32,64,96], reducedMotion: true, motionChecks: motion.length };
}
