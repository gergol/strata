import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const minimalStyle = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#202832' } }],
};
const overpassFixture = {
  elements: [
    {
      type: 'node',
      id: 123,
      lat: 48.21,
      lon: 16.37,
      tags: { amenity: 'drinking_water', name: 'Test fountain' },
    },
  ],
};
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function mockExternalData(page: Page): Promise<void> {
  await page.route('https://tiles.openfreemap.org/styles/liberty', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(minimalStyle), headers: corsHeaders }),
  );
  await page.route('https://raw.githubusercontent.com/gergol/strata/main/**', (route) => {
    if (route.request().url().endsWith('/regions/bidding-zones.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync('regions/bidding-zones.json', 'utf8'), headers: corsHeaders });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ layers: { grid_generation_mix: { ok: true }, osm_drinking_water: { ok: true }, soilgrids_ph: { ok: true } } }),
      headers: corsHeaders,
    });
  });
  await page.route('https://gergol.github.io/strata/data/grid_generation_mix-at.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: readFileSync('packages/client/public/data/grid_generation_mix-at.json', 'utf8'),
      headers: corsHeaders,
    }),
  );
  await page.route('https://overpass-api.de/api/interpreter', (route) => {
    const query = decodeURIComponent(route.request().postData() ?? '');
    const body = query.includes('out count;')
      ? { elements: [{ type: 'count', id: 0, tags: { total: '1' } }] }
      : overpassFixture;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: corsHeaders });
  });
  await page.route('https://maps.isric.org/mapserv?**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng, headers: corsHeaders }),
  );
  await page.route('https://wmts.terrascope.be/wmts?**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng, headers: corsHeaders }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.context().setGeolocation({ latitude: 48.2082, longitude: 16.3738, accuracy: 12 });
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4173' });
  await mockExternalData(page);
});

test('queries the materialized energy and Overpass layers through the real worker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Strata' })).toBeVisible();
  await expect(page.getByText('17 of 17 query layers')).toBeVisible();

  const canvas = page.locator('.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 250, y: 250 } });

  const energyButton = page.getByRole('button', { name: /Electricity generation mix/ });
  await energyButton.click();
  await expect(energyButton).toHaveAttribute('aria-expanded', 'true');
  const energyPanel = page.locator('section.panel').filter({ hasText: 'Electricity generation mix' });
  await expect(energyPanel.getByText(/source:/)).toBeVisible();
  await expect(energyPanel.getByText(/upstream error/i)).toHaveCount(0);
  await expect(energyPanel.locator('.histogram')).toBeVisible();

  const waterButton = page.getByRole('button', { name: /Drinking water points/ });
  await waterButton.click();
  const waterPanel = page.locator('section.panel').filter({ hasText: 'Drinking water points' });
  await expect(waterPanel.locator('.value').first()).toContainText('1');
  await expect(waterPanel.getByText(/Test fountain/)).toBeVisible();
  await expect(page.locator('.map-feature-summary')).toHaveText('1 map point · Drinking water points');
  await waterPanel.getByRole('button', { name: /area stats/ }).click();
  await expect(waterPanel.getByText('count', { exact: true })).toBeVisible();
});

test('selects and centers the current location on startup and from the map control', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/');

  await expect(page.locator('.coords')).toContainText('48.20820, 16.37380 · z14');
  await expect(page.getByRole('status')).toHaveText('Current location selected (within 12 m).');
  const locate = page.getByRole('button', { name: 'Use current location' });
  await expect(locate).toHaveAttribute('aria-busy', 'false');

  const mapBox = await page.locator('.map').boundingBox();
  const markerBox = await page.locator('.maplibregl-marker').boundingBox();
  expect(mapBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(Math.abs((markerBox!.x + markerBox!.width / 2) - (mapBox!.x + mapBox!.width / 2))).toBeLessThan(2);
  // MapLibre's stock pin places its visual tip 6.5 px above the element edge.
  expect(Math.abs((markerBox!.y + markerBox!.height - 6.5) - (mapBox!.y + mapBox!.height / 2))).toBeLessThan(2);

  await page.locator('.maplibregl-canvas').click({ position: { x: 80, y: 80 } });
  await expect(page.locator('.coords')).not.toContainText('48.20820, 16.37380');
  await expect(page.getByText('Current location selected')).toHaveCount(0);
  await page.context().setGeolocation({ latitude: 48.22, longitude: 16.35, accuracy: 8 });
  await locate.click();
  await expect(page.locator('.coords')).toContainText('48.22000, 16.35000 · z14');
  await expect(page.getByRole('status')).toHaveText('Current location selected (within 8 m).');
  expect(consoleErrors).toEqual([]);
});

test('reports denied location permission and preserves map-click selection', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => error({
          code: 1,
          message: 'denied for test',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        } as GeolocationPositionError),
      },
    });
  });
  await page.goto('/');

  await expect(page.getByRole('alert')).toContainText('Location permission was denied.');
  await expect(page.getByRole('button', { name: 'Use current location' })).toBeEnabled();
  await page.locator('.maplibregl-canvas').click({ position: { x: 250, y: 250 } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.coords')).toBeVisible();
});

test('reports unsupported geolocation without blocking map use', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
  });
  await page.goto('/');

  await expect(page.getByRole('alert')).toContainText('Location is not supported by this browser.');
  await page.locator('.maplibregl-canvas').click({ position: { x: 250, y: 250 } });
  await expect(page.locator('.coords')).toBeVisible();
});

test('renders a descriptor-driven raster overlay with opacity and legend controls', async ({ page }) => {
  await page.goto('/');
  const controls = page.getByRole('region', { name: 'Map overlays' });
  const toggle = controls.getByRole('checkbox', { name: 'Soil pH (0–5 cm)' });
  const tileRequest = page.waitForRequest((request) =>
    request.url().startsWith('https://maps.isric.org/mapserv?') && request.url().includes('REQUEST=GetMap'),
  );

  await toggle.check();
  const request = await tileRequest;
  expect(request.url()).toContain('BBOX=');
  expect(request.url()).not.toContain('{bbox-epsg-3857}');
  await expect(controls.getByLabel('Soil pH (0–5 cm) legend')).toBeVisible();
  await expect(controls.getByText('7.0 — neutral')).toBeVisible();

  const opacity = controls.getByLabel('Soil pH (0–5 cm) opacity');
  await opacity.fill('0.35');
  await expect(controls.getByText('35%')).toBeVisible();
  await toggle.uncheck();
  await expect(opacity).toHaveCount(0);

  const worldCoverToggle = controls.getByRole('checkbox', { name: 'WorldCover 2021 (visual)' });
  const worldCoverRequest = page.waitForRequest((request) =>
    request.url().startsWith('https://wmts.terrascope.be/wmts?') && request.url().includes('REQUEST=GetTile'),
  );
  await worldCoverToggle.check();
  const renderedTile = await worldCoverRequest;
  expect(renderedTile.url()).toContain('LAYER=esa-worldcover-map-10m-2021-v2_map');
  expect(renderedTile.url()).not.toMatch(/\{[zxy]\}/);
  await expect(controls.getByLabel('WorldCover 2021 (visual) legend')).toBeVisible();
  await expect(controls.getByText('Built-up')).toBeVisible();

  await page.locator('.maplibregl-canvas').click({ position: { x: 250, y: 250 } });
  await expect(page.locator('section.panel').filter({ hasText: 'WorldCover 2021' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Soil pH/ })).toBeVisible();
});

test('filters the expanded query catalogue by layer name or domain', async ({ page }) => {
  await page.goto('/');
  await page.locator('.maplibregl-canvas').click({ position: { x: 250, y: 250 } });
  const filter = page.getByRole('searchbox', { name: 'Filter layers' });

  await expect(page.getByText('17 of 17 query layers')).toBeVisible();
  await filter.fill('transport');
  await expect(page.getByText('2 of 17 query layers')).toBeVisible();
  await expect(page.getByRole('button', { name: /Bicycle parking/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /EV charging stations/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Soil pH/ })).toHaveCount(0);

  await filter.fill('bookcase');
  await expect(page.getByText('1 of 17 query layers')).toBeVisible();
  const bookcase = page.getByRole('button', { name: /Public bookcases/ });
  await bookcase.click();
  await expect(page.locator('section.panel').filter({ hasText: 'Public bookcases' }).locator('.value')).toContainText('1');

  await filter.fill('no-such-layer');
  await expect(page.getByText('No layers match this filter.')).toBeVisible();
});

test('stores and removes BYOK values without rendering the stored value', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const row = page.locator('.key-row').filter({ hasText: 'NASA FIRMS' });
  const input = row.getByLabel('NASA FIRMS');
  await input.fill('synthetic-test-key');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Key saved only in this browser.', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', 'saved');
  expect(await page.evaluate(() => localStorage.getItem('strata:api-key:firms'))).toBe('synthetic-test-key');

  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  const reloadedRow = page.locator('.key-row').filter({ hasText: 'NASA FIRMS' });
  await expect(reloadedRow.getByLabel('NASA FIRMS')).toHaveValue('');
  await expect(reloadedRow.getByLabel('NASA FIRMS')).toHaveAttribute('placeholder', 'saved');
  await reloadedRow.getByRole('button', { name: 'Remove' }).click();
  expect(await page.evaluate(() => localStorage.getItem('strata:api-key:firms'))).toBeNull();
});

test('keeps map and controls usable in the narrow layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const mapBox = await page.locator('.map').boundingBox();
  expect(mapBox?.height).toBeGreaterThan(300);
  expect(mapBox?.height).toBeLessThan(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const locate = page.getByRole('button', { name: 'Use current location' });
  await locate.focus();
  await locate.press('Enter');
  await expect(page.locator('.coords')).toContainText('48.20820, 16.37380');
  await expect(page.getByRole('checkbox', { name: 'WorldCover 2021 (visual)' })).toBeVisible();
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.focus();
  await settings.press('Enter');
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
});
