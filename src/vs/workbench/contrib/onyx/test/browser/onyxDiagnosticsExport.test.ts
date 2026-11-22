/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { IOnyxDiscoveredModel, IOnyxEndpoint, IOnyxRuntimeService } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { TestEnvironmentService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OnyxDiagnosticsExport } from '../../browser/diagnostics/onyxDiagnosticsExport.js';
import { IOnyxEndpointSecretService, OnyxEndpointSecretService } from '../../browser/model/onyxEndpointSecrets.js';
import { IOnyxKnownModel, IOnyxModelService } from '../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxOutcomeService } from '../../browser/outcomes/onyxOutcomeService.js';
import { IOnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { createStoredZip } from '../../common/onyxZip.js';
import { IOnyxModelProfile, IOnyxRequestRecord, IOnyxRunEvent, IOnyxRunSummary } from '../../common/onyxTypes.js';

/**
 * R-20 (B11): a journal, settings and logs seeded with a different sentinel
 * in every channel that can carry content, exported through the real
 * `OnyxDiagnosticsExport`. The default bundle contains none of them. With
 * the opt-in, content comes back and credentials still do not.
 *
 * Each sentinel is named after the channel it was planted in, so a failure
 * names the leak.
 */
const CONTENT = {
	title: 'SENTINEL-RUN-TITLE-a1',
	promptText: 'SENTINEL-PROMPT-TEXT-b2',
	toolParameter: 'SENTINEL-TOOL-PARAMETER-c3',
	toolResult: 'SENTINEL-TOOL-RESULT-d4',
	activityLabel: 'SENTINEL-ACTIVITY-LABEL-e5',
	activityReason: 'SENTINEL-ACTIVITY-REASON-f6',
	commandOutput: 'SENTINEL-COMMAND-OUTPUT-g7',
	steer: 'SENTINEL-STEER-MESSAGE-h8',
	command: 'SENTINEL-APPROVED-COMMAND-i9',
	workingDirectory: 'SENTINEL-HOME-DIRECTORY-j0',
	responseText: 'SENTINEL-MODEL-RESPONSE-k1',
	acceptedPath: 'SENTINEL-ACCEPTED-PATH-l2',
	location: 'SENTINEL-LOCATION-PATH-m3',
	logMessage: 'SENTINEL-LOG-MESSAGE-n4',
} as const;

/** What no bundle may contain, whatever the user opts into. */
const NEVER = {
	apiKeyInSettings: 'SENTINEL-APIKEY-IN-SETTINGS-o5',
	apiKeyOnModel: 'SENTINEL-APIKEY-ON-MODEL-p6',
	urlPassword: 'SENTINEL-URL-PASSWORD-q7',
	bearerInLog: 'SENTINEL-BEARER-IN-LOG-r8',
	unknownEventKind: 'SENTINEL-UNKNOWN-EVENT-KIND-s9',
	tornLine: 'SENTINEL-TORN-LINE-t0',
	unknownSetting: 'SENTINEL-UNKNOWN-SETTING-u1',
	freeTextSetting: 'SENTINEL-FREE-TEXT-SETTING-v2',
	profileOverrideText: 'SENTINEL-PROFILE-TEXT-w3',
} as const;

const CREDENTIALED_URL = `http://operator:${NEVER.urlPassword}@10.0.0.5:8000/v1`;

const SUMMARY: IOnyxRunSummary = { runId: 'run-1-0', startedAt: 1_700_000_000_000, title: CONTENT.title, task: 'chat', modelKey: '10.0.0.5:8000/coder', status: 'completed', turnCount: 1, toolCallCount: 1 };

function event(kind: string, data: unknown): IOnyxRunEvent {
	return { t: 5, kind: kind as IOnyxRunEvent['kind'], data };
}

const EVENTS: readonly unknown[] = [
	event('trace', { kind: 'trace', v: 2, runId: 'run-1-0', startedAt: 1, harness: { configurationHash: 'abc123', configuration: { promptStyle: 'full', maxTools: 8 } }, model: { identifier: 'onyx:10.0.0.5:8000/coder', digest: null }, runtime: { name: 'vllm', version: null, baseUrl: CREDENTIALED_URL }, sampling: { temperature: 0.2, seed: null, maxTokens: null, responseFormat: false }, tools: [{ name: 'terminal', schemaHash: 'ffff0000' }], context: { budgetedTokens: 16384, source: 'server', requestedTokens: null, reportedTokens: 16384, verifiedTokens: null, mechanism: null } }),
	event('promptSnapshot', {
		turn: 1, model: 'onyx:10.0.0.5:8000/coder', tools: ['terminal'], messages: [
			{ role: 1, content: [{ type: 'text', value: `please ${CONTENT.promptText}` }] },
			{ role: 2, content: [{ type: 'tool_use', name: 'terminal', parameters: { command: CONTENT.toolParameter } }] },
			{ role: 1, content: [{ type: 'tool_result', toolCallId: 'call-1', value: CONTENT.toolResult }] },
		],
	}),
	event('turn', { at: 1, kind: 'turn', label: 'Model turn 1' }),
	event('toolCall', { at: 2, kind: 'toolCall', label: CONTENT.activityLabel, reason: CONTENT.activityReason, location: { path: CONTENT.location, line: 3 } }),
	event('note', { at: 3, kind: 'note', label: 'Output', reason: CONTENT.commandOutput }),
	event('note', { at: 4, kind: 'steer', label: 'Steered', reason: CONTENT.steer }),
	event('approval', { kind: 'approval', command: CONTENT.command, cwd: `/home/${CONTENT.workingDirectory}/project`, timeoutMs: 60_000, decision: 'allow-once', source: 'dialog' }),
	event('traceTurn', { kind: 'traceTurn', v: 2, turn: 1, requestDigest: '0badf00d', responseText: CONTENT.responseText, streamEnd: 'stop', toolCalls: [{ name: 'terminal', argumentsDigest: '11112222', resultDigest: '33334444', ok: true }], seed: { requested: null, honoured: 'unknown' } }),
	event('acceptance', { kind: 'acceptance', path: `src/${CONTENT.acceptedPath}.ts`, hunk: 0 }),
	event('outcome', { status: 'completed' }),
	// Things a journal can hold that the export has never heard of.
	event('somethingNew', { text: NEVER.unknownEventKind }),
	NEVER.tornLine,
	null,
	42,
];

const DISCOVERED: IOnyxDiscoveredModel = { id: 'coder', baseUrl: CREDENTIALED_URL, runtime: 'vllm', family: 'coder', parameterB: 7, contextLength: 16384, supportsTools: true, supportsJsonSchema: false };
const PROFILE: IOnyxModelProfile = { toolCallQuality: 0.9, contextLength: 16384, maxTools: 8, temperature: 0.2, promptStyle: 'full', family: 'coder', parameterB: 7, supportsVision: false };

const LOG = [
	`2026-11-20 10:00:00.000 [info] [onyx] request to ${CREDENTIALED_URL} with ${CONTENT.logMessage}`,
	`2026-11-20 10:00:01.000 [error] 401 Authorization: Bearer ${NEVER.bearerInLog}`,
	`    at continuation line with ${CONTENT.logMessage}`,
	// A key that reached a log by some other road: its value is removed wherever it turns up.
	`2026-11-20 10:00:02.000 [warning] retrying with key ${NEVER.apiKeyOnModel}`,
].join('\n');

function count(haystack: string, needles: Record<string, string>): string[] {
	return Object.entries(needles).filter(([, needle]) => haystack.includes(needle)).map(([name]) => name).sort();
}

/** A configuration service whose writes land, are recorded, and can be made to fail. */
class RecordingConfigurationService extends TestConfigurationService {
	readonly writes: { readonly key: string; readonly value: unknown }[] = [];
	readOnly = false;
	override async updateValue(key: string, value: unknown): Promise<void> {
		if (this.readOnly) {
			throw new Error('the settings file is read-only');
		}
		this.writes.push({ key, value });
		await this.setUserConfiguration('onyx', { endpoints: value });
	}
}

/** A secret storage that counts how often it is read. */
class CountingSecretStorageService extends TestSecretStorageService {
	reads = 0;
	override async get(key: string): Promise<string | undefined> {
		this.reads++;
		return super.get(key);
	}
}

suite('OnyxDiagnosticsExport', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function exportBundle(includeContent: boolean): Promise<{ readonly text: string; readonly zipText: string; readonly paths: string[]; readonly files: ReadonlyMap<string, string> }> {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(TestEnvironmentService.logsHome.scheme, disposables.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(joinPath(TestEnvironmentService.logsHome, 'window1', 'renderer.log'), VSBuffer.fromString(LOG));

		const instantiationService = workbenchInstantiationService({ fileService: () => fileService }, disposables);
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configuration.setUserConfiguration('onyx', {
			endpoints: [{ baseUrl: CREDENTIALED_URL, apiKey: NEVER.apiKeyInSettings, models: ['coder'], contextWindow: 16384 }],
			routing: { mode: 'manual' },
			discovery: { enabled: false },
			verification: { task: NEVER.freeTextSetting },
			autocomplete: { enabled: true, model: NEVER.freeTextSetting },
			futureSetting: { note: NEVER.unknownSetting },
		});
		instantiationService.stub(IWorkbenchEnvironmentService, TestEnvironmentService);

		const record: IOnyxRequestRecord = { ...SUMMARY, events: EVENTS as readonly IOnyxRunEvent[] };
		instantiationService.stub(IOnyxOutcomeService, { _serviceBrand: undefined, onDidChangeRuns: Event.None, listRuns: async () => [SUMMARY], readRun: async () => record } as Partial<IOnyxOutcomeService> as IOnyxOutcomeService);
		const exported: ReturnType<IOnyxProfileService['exportAll']> = {
			stats: {},
			overrides: { '10.0.0.5:8000/coder': { promptStyle: 'compact', maxTools: 6, family: NEVER.profileOverrideText + ' with spaces and a /path' } },
		};
		instantiationService.stub(IOnyxProfileService, { _serviceBrand: undefined, exportAll: () => exported } as Partial<IOnyxProfileService> as IOnyxProfileService);
		const known: IOnyxKnownModel = { key: '10.0.0.5:8000/coder', discovered: DISCOVERED, profile: PROFILE, apiKey: NEVER.apiKeyOnModel, location: { transport: 'lan', execution: 'local' } };
		instantiationService.stub(IOnyxModelService, { _serviceBrand: undefined, getKnownModels: () => [known] } as Partial<IOnyxModelService> as IOnyxModelService);
		const endpoint: IOnyxEndpoint = { baseUrl: CREDENTIALED_URL, kind: 'vllm', displayName: 'vLLM', models: [DISCOVERED] };
		instantiationService.stub(IOnyxRuntimeService, {
			_serviceBrand: undefined,
			getMachineProfile: async () => ({ totalMemoryBytes: 34_359_738_368, freeMemoryBytes: 1_000_000, cpuModel: 'Apple M3 Max', cpuCount: 14, arch: 'arm64', platform: 'darwin' }),
			discoverRuntimes: async () => [endpoint],
		} as Partial<IOnyxRuntimeService> as IOnyxRuntimeService);

		// The keys as the secret storage holds them. The export asks for them only to know what to remove.
		instantiationService.stub(IOnyxEndpointSecretService, {
			_serviceBrand: undefined, onDidChange: Event.None, setApiKey: async () => { },
			configuredApiKeys: async () => new Map([['http://10.0.0.5:8000/v1', NEVER.apiKeyOnModel], ['http://10.0.0.6:8000/v1', NEVER.apiKeyInSettings]]),
		});

		const entries = await instantiationService.createInstance(OnyxDiagnosticsExport).collect(includeContent);
		const decoder = new TextDecoder();
		return {
			text: entries.map(entry => `${entry.path}\n${decoder.decode(entry.data)}`).join('\n'),
			// A stored zip is not compressed: what is in an entry is in the file, byte for byte.
			zipText: decoder.decode(createStoredZip(entries)),
			paths: entries.map(entry => entry.path).sort(),
			files: new Map(entries.map(entry => [entry.path, decoder.decode(entry.data)])),
		};
	}

	test('R-20: the default bundle contains none of the seeded content and none of the credentials; opting in brings the content back and still no credential', async () => {
		const byDefault = await exportBundle(false);
		const optedIn = await exportBundle(true);
		assert.deepStrictEqual({
			default: {
				content: count(byDefault.text, CONTENT),
				credentialsAndUnknowns: count(byDefault.text, NEVER),
				inTheZipBytes: [...count(byDefault.zipText, CONTENT), ...count(byDefault.zipText, NEVER)],
				apiKeyField: /"apiKey"/.test(byDefault.text),
				paths: byDefault.paths,
			},
			optedIn: {
				content: count(optedIn.text, CONTENT),
				credentialsAndUnknowns: count(optedIn.text, NEVER),
				apiKeyField: /"apiKey"/.test(optedIn.text),
			},
		}, {
			default: {
				content: [],
				credentialsAndUnknowns: [],
				inTheZipBytes: [],
				apiKeyField: false,
				paths: ['README.txt', 'journal/index.json', 'journal/runs/run-1-0.jsonl', 'logs/window1/renderer.log', 'machine.json', 'models.json', 'profiles.json', 'runtimes.json', 'settings.json'],
			},
			optedIn: {
				content: Object.keys(CONTENT).sort(),
				credentialsAndUnknowns: [],
				apiKeyField: false,
			},
		});
	});

	test('an API key written in onyx.endpoints is moved into the secret storage and out of the setting; it keeps working when the setting cannot be rewritten; with no endpoint the secret storage is never read', async () => {
		const configuration = new RecordingConfigurationService();
		await configuration.setUserConfiguration('onyx', { endpoints: [{ baseUrl: 'localhost:8000', apiKey: 'key-from-settings', models: ['coder'] }, { baseUrl: 'http://10.0.0.6:9000/v1' }] });
		const secrets = new CountingSecretStorageService();
		await secrets.set('onyx.endpoint.apiKey:http://10.0.0.6:9000/v1', 'key-already-stored');
		const service = store.add(new OnyxEndpointSecretService(secrets, configuration, new NullLogService()));

		const first = [...await service.configuredApiKeys()];
		const settingAfterFirst = configuration.getValue('onyx.endpoints');
		const second = [...await service.configuredApiKeys()];
		await service.setApiKey('localhost:8000', undefined);
		const afterRemoval = [...await service.configuredApiKeys()];

		const readOnly = new RecordingConfigurationService();
		readOnly.readOnly = true;
		await readOnly.setUserConfiguration('onyx', { endpoints: [{ baseUrl: 'localhost:8000', apiKey: 'key-from-settings' }] });
		const stuck = [...await store.add(new OnyxEndpointSecretService(new TestSecretStorageService(), readOnly, new NullLogService())).configuredApiKeys()];

		const untouched = new CountingSecretStorageService();
		const none = [...await store.add(new OnyxEndpointSecretService(untouched, new RecordingConfigurationService(), new NullLogService())).configuredApiKeys()];

		assert.deepStrictEqual({ first, settingAfterFirst, writes: configuration.writes.length, stored: (await secrets.keys()).sort(), second, afterRemoval, stuck, none, readsWithNoEndpoint: untouched.reads }, {
			first: [['http://localhost:8000/v1', 'key-from-settings'], ['http://10.0.0.6:9000/v1', 'key-already-stored']],
			settingAfterFirst: [{ baseUrl: 'localhost:8000', models: ['coder'] }, { baseUrl: 'http://10.0.0.6:9000/v1' }],
			writes: 1,
			stored: ['onyx.endpoint.apiKey:http://10.0.0.6:9000/v1'],
			second: [['http://localhost:8000/v1', 'key-from-settings'], ['http://10.0.0.6:9000/v1', 'key-already-stored']],
			afterRemoval: [['http://10.0.0.6:9000/v1', 'key-already-stored']],
			stuck: [['http://localhost:8000/v1', 'key-from-settings']],
			none: [],
			readsWithNoEndpoint: 0,
		});
	});

	test('the default bundle still says what happened: kinds, counts, sizes, timings and identifiers survive', async () => {
		const bundle = await exportBundle(false);
		const journal = (bundle.files.get('journal/runs/run-1-0.jsonl') ?? '').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
		const byKind = (kind: string) => journal.filter(entry => entry.kind === kind).map(entry => entry.data);
		assert.deepStrictEqual({
			kinds: journal.map(entry => entry.kind),
			approval: byKind('approval'),
			traceRuntime: (byKind('trace')[0] as { runtime: unknown }).runtime,
			snapshotMessages: (byKind('promptSnapshot')[0] as { messages: unknown }).messages,
			traceTurn: byKind('traceTurn')[0],
			log: (bundle.files.get('logs/window1/renderer.log') ?? '').split('\n'),
		}, {
			kinds: ['trace', 'promptSnapshot', 'turn', 'toolCall', 'note', 'note', 'approval', 'traceTurn', 'acceptance', 'outcome'],
			approval: [{ kind: 'approval', command: '[redacted 28 chars]', cwd: '[redacted 40 chars]', timeoutMs: 60_000, decision: 'allow-once', source: 'dialog' }],
			traceRuntime: { name: 'vllm', version: null, baseUrl: 'http://10.0.0.5:8000/v1' },
			snapshotMessages: [
				{ role: 1, content: [{ type: 'text', chars: 30 }] },
				{ role: 2, content: [{ type: 'tool_use', name: 'terminal', chars: 40 }] },
				{ role: 1, content: [{ type: 'tool_result', chars: 23 }] },
			],
			traceTurn: { kind: 'traceTurn', v: 2, turn: 1, requestDigest: '0badf00d', responseText: '[redacted 26 chars]', streamEnd: 'stop', toolCalls: [{ name: 'terminal', argumentsDigest: '11112222', resultDigest: '33334444', ok: true }], seed: { requested: null, honoured: 'unknown' } },
			log: [
				'2026-11-20 10:00:00.000 [info] [redacted 104 chars]',
				'2026-11-20 10:00:01.000 [error] [redacted 51 chars]',
				'[redacted 53 chars]',
				'2026-11-20 10:00:02.000 [warning] [redacted 45 chars]',
			],
		});
	});
});
