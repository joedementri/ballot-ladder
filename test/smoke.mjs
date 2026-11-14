// Browser smoke test: drives the built game in headless Chrome/Edge.
//   npm run build && npx vite preview --port 4173 &  then  node test/smoke.mjs [outDir]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'smoke-out';
mkdirSync(out, { recursive: true });
const url = process.env.URL ?? 'http://localhost:4173/';
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true });
const errors = [];
const run = async (viewport, tag) => {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror ${e.message}`));
  globalThis.__page = page;
  const t0 = Date.now();
  await page.goto(url);
  await page.getByRole('button', { name: 'New career' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.body.innerText.includes('Loading map data'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log(`[${tag}] title ready in ${Date.now() - t0}ms`);
  await page.screenshot({ path: join(out, `${tag}-1-title.png`) });

  await page.getByRole('button', { name: 'New career' }).click();
  await page.getByPlaceholder('Jordan').fill('Avery');
  await page.getByPlaceholder('Reyes').fill('Quinn');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByPlaceholder('Search towns, cities, townships…').fill('Lansdale');
  await page.getByRole('button', { name: /^Lansdale/ }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${tag}-2-home.png`) });
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.screenshot({ path: join(out, `${tag}-3-platform.png`) });
  await page.getByRole('button', { name: 'Begin career' }).click();
  await page.getByRole('button', { name: 'End month' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${tag}-4-run.png`) });

  // file for the first council seat up in 2025
  await page.getByRole('button', { name: 'File to run' }).first().click();
  await page.waitForTimeout(600);
  // take a couple of actions
  for (let i = 0; i < 3; i++) {
    const btn = page.getByRole('button', { name: 'Do it' }).first();
    if (await btn.isEnabled()) await btn.click();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: join(out, `${tag}-5-campaign.png`) });
  // help popover on a top-bar stat
  const cashLabel = page.locator('header >> text="Cash" >> visible=true').first();
  if (tag === 'mobile') await cashLabel.click();
  else await cashLabel.hover();
  await page.getByRole('tooltip').waitFor({ timeout: 3000 });
  await page.screenshot({ path: join(out, `${tag}-5b-tooltip.png`) });
  await page.mouse.move(5, 300);

  // first End month shows the month summary
  const summary = page.getByRole('dialog', { name: /summary/ });
  await page.getByRole('button', { name: 'End month' }).click();
  await summary.waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${tag}-5c-summary.png`) });
  const closeSummary = async () => {
    if (await summary.isVisible().catch(() => false)) await summary.getByRole('button', { name: 'Continue' }).click();
  };
  await closeSummary();

  // play to November election night
  for (let m = 0; m < 12; m++) {
    await closeSummary();
    const night = page.getByRole('region', { name: /Election night/ });
    if (await night.isVisible().catch(() => false)) break;
    await page.getByRole('button', { name: 'End month' }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Simulating')), null, { timeout: 30000 });
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, `${tag}-6-night.png`) });
  const cont = page.getByRole('button', { name: 'Continue' });
  if (await cont.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Skip' }).click().catch(() => {});
    await cont.click();
  }
  await page.waitForTimeout(500);
  await closeSummary();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${tag}-6b-after.png`) });

  // M13: skip ahead (the race is over), hotkeys, then a second save slot and a reload from the title screen
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Second slot' : undefined));
  const idle = () => page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Simulating')), null, { timeout: 60000 });
  const dateText = () => page.locator('header').getByText(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/).first().textContent();
  const before = await dateText();
  await page.getByRole('button', { name: 'Skip ahead' }).click();
  await idle();
  await summary.waitFor({ timeout: 30000 });
  if (!(await summary.innerText()).includes('passed')) throw new Error('skip summary has no span');
  await page.screenshot({ path: join(out, `${tag}-6c-skip.png`) });
  console.log(`[${tag}] skipped ${before} → ${await dateText()}`);
  await page.keyboard.press('Escape');
  await summary.waitFor({ state: 'hidden', timeout: 3000 });
  await page.keyboard.press('m');
  await summary.waitFor({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('5');
  await page.getByRole('button', { name: 'News' }).waitFor();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'Save as new slot…' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'Title screen' }).click();
  const slots = page.getByRole('list', { name: 'Saved games' }).getByRole('listitem');
  await slots.first().waitFor({ timeout: 10000 });
  const n = await slots.count();
  if (n < 2) throw new Error(`expected 2 save slots, found ${n}`);
  await page.screenshot({ path: join(out, `${tag}-6d-slots.png`) });
  await page.getByRole('button', { name: 'Continue Second slot' }).click();
  await page.getByRole('button', { name: 'End month' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  // map layers & stats
  await page.getByRole('button', { name: 'Stats' }).click();
  await page.getByRole('button', { name: 'Congress' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${tag}-7-stats.png`) });
  await page.getByRole('button', { name: 'St. House' }).click();
  await page.waitForTimeout(4000);
  await page.mouse.click(viewport.width * 0.3, viewport.height * 0.5);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${tag}-8-sldl-inspector.png`) });
  await page.getByRole('button', { name: 'Career' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${tag}-9-career.png`) });
  // M11: a rival's card, then their turf on the map with town boundaries (PMTiles over HTTP range requests)
  await page.getByRole('button', { name: 'County', exact: true }).click();
  const rival = page.locator('aside button[aria-expanded]').first();
  await rival.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${tag}-10-rival.png`) });
  // (switch to shapes first: on phones the inspector covers the map controls)
  await page.getByRole('button', { name: 'Close inspector' }).click().catch(() => {});
  await page.getByRole('button', { name: 'Shapes' }).click();
  await page.getByRole('button', { name: 'Show on map' }).first().click();
  await page.waitForTimeout(3500);
  await page.mouse.move(viewport.width * 0.35, viewport.height * 0.3);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${tag}-11-town-shapes.png`) });
  // M17: retire (the dialog handler accepts the confirm), read the career recap, find the career in the hall of fame
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Retire from politics/ }).click();
  const recap = page.getByRole('dialog', { name: 'Career over' });
  await recap.waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${tag}-12-career-end.png`) });
  const [card] = await Promise.all([page.waitForEvent('download'), recap.getByRole('button', { name: 'Export career card' }).click()]);
  await card.saveAs(join(out, `${tag}-12b-career-card.png`));
  await recap.getByRole('button', { name: 'Title screen' }).click();
  await page.getByRole('list', { name: 'Hall of fame' }).getByRole('listitem').first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(out, `${tag}-13-hall.png`) });
  await page.close();
};

try {
  for (const [vp, tag] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']]) {
    await run(vp, tag).catch(async (e) => {
      errors.push(`${tag} failed: ${e.message.split(/\r?\n/)[0]}`);
      await globalThis.__page?.screenshot({ path: join(out, `${tag}-failed.png`) }).catch(() => {});
    });
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
