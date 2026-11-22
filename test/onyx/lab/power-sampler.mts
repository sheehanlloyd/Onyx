/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * System power from the battery controller, without elevated privileges
 * (L18, H-10).
 *
 *   node test/onyx/lab/power-sampler.mts --probe [--seconds 150] [--out <probe.json>]
 *   node test/onyx/lab/power-sampler.mts --out <power.jsonl>        (until it is stopped)
 *
 * What is read: on an Apple laptop, `ioreg -rn AppleSmartBattery` shows a
 * `PowerTelemetryData` dictionary. `SystemLoad` is the power the system is
 * drawing, in milliwatts. `AccumulatedSystemLoad` is the sum of one such
 * sample a second, and `SystemLoadAccumulatorCount` is how many samples
 * that is: the difference of the first between two readings, in
 * milliwatt-seconds, is the energy between them in millijoules, and the
 * difference of the second is the seconds it covers. The registry is
 * refreshed about once a minute, which is the method's resolution: this
 * script polls once a second and writes a line each time the count moves.
 *
 * `--probe` says whether the telemetry is there, how often it refreshes,
 * and whether it agrees with itself (voltage × current against the power
 * reported in, and the two energy accumulators against each other). Where
 * the dictionary is absent, as on a desktop Mac or another system, the
 * probe says so and exits 3: energy is then unavailable on that hardware,
 * and nothing else is to be put in its place.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface IReading { readonly at: number; readonly count: number; readonly accumulatedLoad: number; readonly accumulatedEnergy: number | null; readonly systemLoad: number; readonly powerIn: number | null; readonly voltageIn: number | null; readonly currentIn: number | null; readonly external: boolean | null }

function read(): IReading | undefined {
	let text: string;
	try {
		text = execFileSync('ioreg', ['-rn', 'AppleSmartBattery'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
	} catch {
		return undefined;
	}
	const telemetry = /"PowerTelemetryData" = \{(?<body>[^}]*)\}/.exec(text)?.groups?.body;
	if (!telemetry) {
		return undefined;
	}
	const number = (name: string): number | null => {
		const found = new RegExp(`"${name}"=(?<value>\\d+)`).exec(telemetry)?.groups?.value;
		return found === undefined ? null : Number(found);
	};
	const count = number('SystemLoadAccumulatorCount');
	const accumulatedLoad = number('AccumulatedSystemLoad');
	const systemLoad = number('SystemLoad');
	if (count === null || accumulatedLoad === null || systemLoad === null) {
		return undefined;
	}
	const external = /"ExternalConnected" = (?<value>Yes|No)/.exec(text)?.groups?.value;
	return { at: Date.now(), count, accumulatedLoad, accumulatedEnergy: number('AccumulatedSystemEnergyConsumed'), systemLoad, powerIn: number('SystemPowerIn'), voltageIn: number('SystemVoltageIn'), currentIn: number('SystemCurrentIn'), external: external === undefined ? null : external === 'Yes' };
}

const flag = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const outPath = flag('--out') ? path.resolve(flag('--out')!) : undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--probe')) {
	const seconds = Number(flag('--seconds') ?? 150);
	const first = read();
	if (!first) {
		const result = { available: false, platform: process.platform, reason: 'ioreg shows no PowerTelemetryData with a system load accumulator on this machine' };
		if (outPath) {
			fs.writeFileSync(outPath, JSON.stringify(result, undefined, '\t') + '\n');
		}
		console.log('power telemetry: unavailable on this hardware');
		process.exit(3);
	}
	const refreshes: IReading[] = [first];
	for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
		await sleep(1000);
		const reading = read();
		if (reading && reading.count !== refreshes.at(-1)!.count) {
			refreshes.push(reading);
		}
	}
	const intervals = refreshes.slice(1).map((reading, index) => {
		const before = refreshes[index];
		const samples = reading.count - before.count;
		const millijoules = reading.accumulatedLoad - before.accumulatedLoad;
		// The second accumulator, when it is there, moves by about a microwatt-hour for 3.6 millijoules.
		const other = reading.accumulatedEnergy !== null && before.accumulatedEnergy !== null ? (reading.accumulatedEnergy - before.accumulatedEnergy) * 3.6 : null;
		return { wallSeconds: Math.round((reading.at - before.at) / 1000), samples, meanWatts: Math.round(millijoules / samples) / 1000, joules: Math.round(millijoules / 1000), joulesByTheOtherAccumulator: other === null ? null : Math.round(other / 1000) };
	});
	const result = {
		available: true,
		platform: process.platform,
		probedSeconds: seconds,
		onExternalPower: first.external,
		refreshesSeen: refreshes.length - 1,
		// The first interval starts wherever the probe started, so its wall seconds are short of a whole one.
		intervals,
		voltageTimesCurrentAgainstPowerIn: refreshes.filter(reading => reading.powerIn && reading.voltageIn && reading.currentIn).map(reading => Math.round(reading.voltageIn! * reading.currentIn! / 1000 / reading.powerIn! * 1000) / 1000),
		units: 'SystemLoad and SystemPowerIn in milliwatts; AccumulatedSystemLoad in milliwatt-seconds, one sample a second; AccumulatedSystemEnergyConsumed in microwatt-hours',
		accuracy: 'Not established against an external meter. What is established is that the readings agree with each other: see voltageTimesCurrentAgainstPowerIn (1 is exact agreement) and the two energy columns of each interval.',
	};
	if (outPath) {
		fs.writeFileSync(outPath, JSON.stringify(result, undefined, '\t') + '\n');
	}
	console.log(JSON.stringify(result, undefined, '\t'));
	process.exit(0);
}

if (!outPath) {
	console.error('usage: node test/onyx/lab/power-sampler.mts --probe [--seconds <n>] [--out <probe.json>] | --out <power.jsonl>');
	process.exit(2);
}
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
let last: IReading | undefined;
while (!stopped) {
	const reading = read();
	if (!reading) {
		console.error('power-sampler: no power telemetry on this machine');
		process.exit(3);
	}
	if (!last || reading.count !== last.count) {
		fs.appendFileSync(outPath, JSON.stringify({ at: reading.at, count: reading.count, accumulatedLoad: reading.accumulatedLoad, systemLoad: reading.systemLoad, external: reading.external }) + '\n');
		last = reading;
	}
	await sleep(1000);
}
