import { readFile } from 'node:fs/promises';
import { exampleTripTest as test, expect } from './local-planner-fixture.js';
import { STORAGE_KEY } from '../src/model.js';

const studio = page => page.locator('.story-studio-host');
const field = (page, id) => studio(page).locator(`#${id}`);
const savedState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);

// Runs only against a dedicated, isolated /demo instance; never changes the user's account or original tree.
// The editor starts collapsed by default; these tests drive its fields, so they open it first.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('storybook-editor-hidden-v2','0');}catch{}});});
test('[studio] old schedule UI is replaced by an itinerary-driven four-car storybook @critical', async ({page}) => {
  await page.goto('/demo');
  await expect(studio(page)).toBeVisible();
  await expect(field(page, 'poster')).toBeAttached();
  await expect(studio(page).locator('[data-studio-root]')).toBeVisible();
  if (page.viewportSize().width <= 980) await field(page, 'viewPreview').click();
  await expect(field(page, 'journal')).toBeVisible();
  await expect(page.locator('.plan-view-switch,.itinerary-poster')).toHaveCount(0);
  const initial=await savedState(page);
  expect(initial.routes.length).toBe(8);
  expect(initial.vehicles.length).toBe(4);
  await expect(studio(page).locator('#itineraryText')).toContainText('第三車・採買組');
  await expect(studio(page).locator('#itineraryText')).toContainText('超市／賣場');
});

test('[studio] one poster edit saves website state and survives reload without dropping the route, meals or shopping', async ({page}) => {
  await page.goto('/demo');
  await expect(studio(page)).toBeVisible();
  const before=await savedState(page);
  await field(page, 'tab-cover').click();
  await field(page, 'headline').fill('四車慢遊測試');
  await expect.poll(async()=> (await savedState(page)).storybook?.headline).toBe('四車慢遊測試');
  const after=await savedState(page);
  expect(after.storybook?.headline).toBe('四車慢遊測試');
  for (const key of ['vehicles','routes','meals','shopping','gear','people']) expect(after[key]).toEqual(before[key]);
  await page.reload();
  await expect(field(page, 'headline')).toHaveValue('四車慢遊測試');
});

test('[studio] a draft survives leaving and returning to schedule, and autosave then stores it', async ({page}) => {
  await page.goto('/demo');
  await expect(studio(page)).toBeVisible();
  const before=await savedState(page);
  await field(page, 'tab-cover').click();
  await field(page, 'headline').fill('待儲存草稿');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('.section-tabs [data-tab="shopping"]').click();
  expect(before.storybook?.headline).not.toBe('待儲存草稿');
  await expect.poll(async()=> (await savedState(page)).storybook?.headline).toBe('待儲存草稿');
  await page.locator('.section-tabs [data-tab="schedule"]').click();
  await expect(field(page, 'headline')).toHaveValue('待儲存草稿');
});



test('[studio] a car stop note and meal edit save with original IDs and unlinked shopping intact', async ({page}) => {
  await page.goto('/demo');
  await expect(studio(page)).toBeVisible();
  const before=await savedState(page);
  await studio(page).locator('#route-entry-2 > summary').click();
  await field(page, 'stop-2-0-notes').fill('記得冷藏食材');
  await field(page, 'section-events').click();
  const meal=studio(page).locator('#eventList li.entry:has(.meal-badge)');
  await meal.locator('summary').click();
  await meal.locator('textarea').fill('晚餐前提醒大家洗手');
  await expect.poll(async()=> (await savedState(page)).routes.find(route=>route.id==='rt-1-v3').stops[0].note).toBe('記得冷藏食材');
  await expect.poll(async()=> (await savedState(page)).meals.find(x=>x.id==='m1').notes).toBe('晚餐前提醒大家洗手');
  const after=await savedState(page);
  expect(after.routes.map(x=>x.id)).toEqual(before.routes.map(x=>x.id));
  expect(after.routes.find(x=>x.id==='rt-1-v3').stops[0].id).toBe('st-1');
  expect(after.meals.find(x=>x.id==='m1').notes).toBe('晚餐前提醒大家洗手');
  expect(after.meals.map(x=>x.id)).toEqual(before.meals.map(x=>x.id));
  expect(after.shopping).toEqual(before.shopping);
  await page.reload();
  await expect(field(page, 'stop-2-0-notes')).toHaveValue('記得冷藏食材');
});


