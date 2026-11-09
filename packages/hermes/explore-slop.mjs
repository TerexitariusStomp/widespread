import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/slop-browse/profile', {
  executablePath: '/usr/bin/brave', headless: false,
  args: ['--remote-debugging-port=9222', '--no-first-run'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const url of ['https://slop.cash/SKILL.md', 'https://slop.cash/projects/eliza/skill.md', 'https://slop.cash/projects/slopdotcash/skill.md']) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  console.log(`\n########## ${url} ##########`);
  console.log(text.slice(0, 4000));
}
await ctx.close();
