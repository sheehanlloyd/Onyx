/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Regenerates every PNG in this folder from the SVG sources.
// Usage, from the repository root:  node docs/brand/render.mts
// Renderer: headless Chromium through the repository's own `playwright` dependency.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const directions = [
	{ id: 'direction-a', label: 'A  Hunk' },
	{ id: 'direction-b', label: 'B  Gauge' },
	{ id: 'direction-c', label: 'C  Split' }
];
const iconSizes = [16, 32, 64, 128, 256, 512, 1024];
const monoSizes = [16, 32, 64];
const sheetSizes = [16, 32, 64, 128, 256];
const monoThemes = [
	{ name: 'light', color: '#000000', background: '#f2f2f2' },
	{ name: 'dark', color: '#ffffff', background: '#1e1e1e' }
];
const sheetThemes = [
	{
		name: 'light', page: '#f4f4f2', text: '#222222', rule: '#d8d8d4',
		wallpaper: 'linear-gradient(135deg, #f3d9c4 0%, #cfdcee 55%, #e9e4f2 100%)',
		bar: 'rgba(255, 255, 255, 0.42)', barEdge: 'rgba(255, 255, 255, 0.7)', filler: 'rgba(120, 124, 132, 0.55)'
	},
	{
		name: 'dark', page: '#1c1c1e', text: '#e6e6e6', rule: '#3a3a3d',
		wallpaper: 'linear-gradient(135deg, #1a1f38 0%, #3a2440 55%, #101418 100%)',
		bar: 'rgba(40, 40, 46, 0.45)', barEdge: 'rgba(255, 255, 255, 0.16)', filler: 'rgba(150, 154, 162, 0.4)'
	}
];

/**
 * Finds a Chromium build to launch. Prefers the one matching the installed playwright
 * version, then any build already present in the playwright cache. Set BRAND_CHROMIUM
 * to force a specific executable.
 */
function findChromium() {
	if (process.env.BRAND_CHROMIUM) {
		return process.env.BRAND_CHROMIUM;
	}
	if (existsSync(chromium.executablePath())) {
		return undefined;
	}
	const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright');
	const candidates = [
		['chromium_headless_shell-', join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell')],
		['chromium_headless_shell-', join('chrome-headless-shell-mac-x64', 'chrome-headless-shell')],
		['chromium-', join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')],
		['chromium-', join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
	];
	const entries = existsSync(cache) ? readdirSync(cache).sort().reverse() : [];
	for (const [prefix, tail] of candidates) {
		for (const entry of entries) {
			const candidate = join(cache, entry, tail);
			if (entry.startsWith(prefix) && existsSync(candidate)) {
				return candidate;
			}
		}
	}
	throw new Error('No Chromium found. Set BRAND_CHROMIUM to a Chromium or Chrome executable.');
}

function dataUri(svg) {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function pngUri(buffer) {
	return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * Renders one SVG at one pixel size. A transparent page is used when no background is given.
 */
async function renderSvg(browser, svg, size, path, color, background) {
	const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
	const sized = svg.replace(/<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, `<svg$1 width="${size}" height="${size}"`);
	await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:${background ?? 'transparent'};color:${color ?? '#000000'}"><div style="width:${size}px;height:${size}px;line-height:0">${sized}</div></body></html>`);
	const buffer = await page.screenshot({ path, omitBackground: !background, clip: { x: 0, y: 0, width: size, height: size } });
	await page.close();
	return buffer;
}

function sheetHtml(theme, sources) {
	const rows = sources.map(source => {
		const cells = sheetSizes.map(size => `<td><img src="${dataUri(source.icon)}" width="${size}" height="${size}"><div class="cap">${size}</div></td>`).join('');
		const zoom = `<td><img class="px" src="${pngUri(source.icon16)}" width="128" height="128"><div class="cap">16 px render, 8x</div></td>`;
		const mono = `<td><div class="mono">${[16, 32].map(size => `<img src="${pngUri(source.mono[`${size}-${theme.name}`])}" width="${size}" height="${size}">`).join('')}</div><div class="cap">mono 16, 32</div></td>`;
		return `<tr><th>${source.label}</th>${cells}${zoom}${mono}</tr>`;
	}).join('');
	const filler = `<div class="filler"></div>`;
	const dock = sources.map(source => `<img src="${dataUri(source.icon)}" width="128" height="128">`).join('');
	return `<!DOCTYPE html><html><head><style>
		body { margin: 0; padding: 32px; width: 1180px; background: ${theme.page}; color: ${theme.text}; font: 13px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; }
		h1 { font-size: 15px; font-weight: 600; margin: 0 0 16px; }
		table { border-collapse: collapse; width: 100%; }
		th { text-align: left; font-weight: 600; width: 90px; white-space: pre; }
		td { text-align: center; vertical-align: bottom; padding: 20px 10px 14px; }
		tr { border-bottom: 1px solid ${theme.rule}; }
		img { display: inline-block; }
		.px { image-rendering: pixelated; }
		.cap { margin-top: 8px; font-size: 11px; opacity: 0.6; }
		.mono { display: flex; gap: 12px; align-items: flex-end; justify-content: center; }
		.wall { margin-top: 32px; height: 300px; border-radius: 12px; background: ${theme.wallpaper}; display: flex; align-items: flex-end; justify-content: center; }
		.dock { margin-bottom: 20px; padding: 14px 18px 18px; display: flex; gap: 6px; border-radius: 38px; background: ${theme.bar}; border: 1px solid ${theme.barEdge}; backdrop-filter: blur(30px) saturate(1.6); }
		.filler { width: 103px; height: 103px; margin: 12.5px; border-radius: 23px; background: ${theme.filler}; }
	</style></head><body>
		<h1>Three icon directions, ${theme.name} background. Sizes in px at 1x.</h1>
		<table>${rows}</table>
		<div class="wall"><div class="dock">${filler}${filler}${dock}${filler}${filler}</div></div>
	</body></html>`;
}

async function main() {
	const browser = await chromium.launch({ executablePath: findChromium() });
	const sources = [];
	for (const direction of directions) {
		const folder = join(here, direction.id);
		const icon = readFileSync(join(folder, 'icon.svg'), 'utf8');
		const mono = readFileSync(join(folder, 'mono.svg'), 'utf8');
		const source = { label: direction.label, icon, mono: {} };
		for (const size of iconSizes) {
			const buffer = await renderSvg(browser, icon, size, join(folder, `icon-${size}.png`));
			if (size === 16) {
				source.icon16 = buffer;
			}
		}
		for (const theme of monoThemes) {
			for (const size of monoSizes) {
				source.mono[`${size}-${theme.name}`] = await renderSvg(browser, mono, size, join(folder, `mono-${size}-${theme.name}.png`), theme.color, theme.background);
			}
		}
		sources.push(source);
	}
	for (const theme of sheetThemes) {
		const page = await browser.newPage({ viewport: { width: 1244, height: 800 }, deviceScaleFactor: 1 });
		await page.setContent(sheetHtml(theme, sources));
		await page.screenshot({ path: join(here, `sheet-${theme.name}.png`), fullPage: true });
		await page.close();
	}
	await browser.close();
}

await main();
