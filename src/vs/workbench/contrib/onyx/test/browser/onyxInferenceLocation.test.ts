/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IOnyxChatParams, IOnyxDiscoveredModel, IOnyxEndpoint, IOnyxRuntimeService, IOnyxStreamEvent } from '../../../../../platform/onyxRuntime/common/onyxRuntime.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ChatMessageRole } from '../../../chat/common/languageModels.js';
import { IOnyxEndpointSecretService } from '../../browser/model/onyxEndpointSecrets.js';
import { OnyxModelService } from '../../browser/model/onyxLanguageModelProvider.js';
import { IOnyxContextAllocationService, OnyxContextAllocationService } from '../../browser/models/onyxContextAllocationService.js';
import { IOnyxProfileService } from '../../browser/profiles/onyxProfileService.js';
import { classifyTransport, decideInferenceUse, describeExecution, describeRefusal, describeTransport, IOnyxInferencePolicy, locationBadge } from '../../common/onyxInferenceLocation.js';
import { seedProfile } from '../../common/onyxSeedProfiles.js';

/**
 * R-17 (B14, DEC-04): where a request is sent and where the model runs are
 * two different facts, and a loopback URL settles only the first. The real
 * model service is given what four servers report about themselves: an
 * Ollama on this machine with one model it runs and one it forwards to a
 * cloud service, a vLLM on the local network, a server on this machine that
 * does not say what it is, and one on the internet.
 */

const LOCAL: IOnyxDiscoveredModel = { id: 'coder:7b', baseUrl: 'http://localhost:11434/v1', runtime: 'ollama', execution: 'local' };
const CLOUD: IOnyxDiscoveredModel = { id: 'coder:480b-cloud', baseUrl: 'http://localhost:11434/v1', runtime: 'ollama', execution: 'cloud', remoteHost: 'https://ollama.com:443' };
const LAN: IOnyxDiscoveredModel = { id: 'coder-lan', baseUrl: 'http://192.168.1.20:8000/v1', runtime: 'vllm', execution: 'local' };
const UNKNOWN: IOnyxDiscoveredModel = { id: 'coder-proxy', baseUrl: 'http://localhost:9000/v1', runtime: 'generic' };
const REMOTE: IOnyxDiscoveredModel = { id: 'coder-hosted', baseUrl: 'https://api.example.com/v1', runtime: 'generic' };
const ALL = [LOCAL, CLOUD, LAN, UNKNOWN, REMOTE];

const ENDPOINTS: IOnyxEndpoint[] = [...new Set(ALL.map(model => model.baseUrl))].map(baseUrl => ({ baseUrl, kind: ALL.find(model => model.baseUrl === baseUrl)!.runtime, displayName: 'runtime', models: ALL.filter(model => model.baseUrl === baseUrl) }));

suite('OnyxInferenceLocation', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function observe(policy: Partial<IOnyxInferencePolicy>) {
		const disposables = store.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configuration.setUserConfiguration('onyx', { inference: policy, discovery: { enabled: true } });

		const sent: string[] = [];
		const onDidStream = disposables.add(new Emitter<IOnyxStreamEvent>());
		instantiationService.stub(IOnyxRuntimeService, {
			_serviceBrand: undefined,
			onDidChangeRuntimes: Event.None,
			onDidStream: onDidStream.event,
			discoverRuntimes: async () => ENDPOINTS,
			startChatCompletion: async (operationId: string, params: IOnyxChatParams) => {
				sent.push(params.model);
				onDidStream.fire({ operationId, kind: 'delta', text: 'ok' });
				onDidStream.fire({ operationId, kind: 'done', finishReason: 'stop', ending: 'complete' });
			},
			cancel: async () => { },
			getMachineProfile: async () => ({ totalMemoryBytes: 34_359_738_368, freeMemoryBytes: 8_000_000_000, cpuModel: 'test', cpuCount: 8, arch: 'arm64', platform: 'darwin' }),
		} as Partial<IOnyxRuntimeService> as IOnyxRuntimeService);
		instantiationService.stub(IOnyxProfileService, { _serviceBrand: undefined, onDidChangeProfiles: Event.None, getProfile: (_key: string, discovered: IOnyxDiscoveredModel) => seedProfile(discovered) } as Partial<IOnyxProfileService> as IOnyxProfileService);
		instantiationService.stub(IOnyxEndpointSecretService, { _serviceBrand: undefined, onDidChange: Event.None, setApiKey: async () => { }, configuredApiKeys: async () => new Map<string, string>() });

		instantiationService.stub(IOnyxContextAllocationService, disposables.add(instantiationService.createInstance(OnyxContextAllocationService)));
		const service = disposables.add(instantiationService.createInstance(OnyxModelService));
		await service.refresh();
		const picker = await service.provideLanguageModelChatInfo();

		const outcomes: Record<string, string> = {};
		for (const model of ALL) {
			const info = picker.find(entry => entry.metadata.name === model.id);
			try {
				const response = await service.sendChatRequest(info?.identifier ?? `onyx:missing/${model.id}`, [{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hi' }] }], undefined, {}, CancellationToken.None);
				for await (const _part of response.stream) {
					// drain
				}
				await response.result;
				outcomes[model.id] = 'sent';
			} catch (error) {
				// The reason is the sentence that begins "Not used:"; what follows it describes the location.
				const reason = /Not used: (?<why>[^.]*)\./.exec(String(error))?.groups?.why ?? '';
				outcomes[model.id] = /cloud-backed/.test(reason) ? 'refused: cloud' : /on your network/.test(reason) ? 'refused: lan' : /does not say where/.test(reason) ? 'refused: unknown' : /over the internet/.test(reason) ? 'refused: remote' : `error: ${String(error).slice(0, 60)}`;
			}
		}
		return {
			used: service.getKnownModels().map(model => model.discovered.id),
			outcomes,
			reachedTheRuntime: sent,
			details: Object.fromEntries(picker.filter(entry => entry.metadata.id !== 'auto').map(entry => [entry.metadata.name, entry.metadata.detail])),
			everyTooltipNamesBoth: picker.filter(entry => entry.metadata.id !== 'auto').every(entry => /Requests are sent/.test(entry.metadata.tooltip ?? '') && /(reports that|does not say where)/.test(entry.metadata.tooltip ?? '')),
			anythingSaysVerified: picker.some(entry => /verif|guarantee|100%/i.test(`${entry.metadata.detail ?? ''} ${entry.metadata.tooltip ?? ''}`)),
		};
	}

	test('R-17: by default only a model the runtime says it runs itself, on this machine, is used; cloud-backed through loopback, a LAN endpoint, an unidentified server and the internet are refused with the reason, and nothing is sent to them', async () => {
		const result = await observe({});
		assert.deepStrictEqual(result, {
			used: ['coder:7b'],
			outcomes: { 'coder:7b': 'sent', 'coder:480b-cloud': 'refused: cloud', 'coder-lan': 'refused: lan', 'coder-proxy': 'refused: unknown', 'coder-hosted': 'refused: remote' },
			reachedTheRuntime: ['coder:7b'],
			details: {
				'coder:7b': 'Ollama',
				'coder:480b-cloud': 'Ollama · cloud-backed · not used',
				'coder-lan': 'vLLM · LAN · not used',
				'coder-proxy': 'OpenAI-compatible · location unknown · not used',
				'coder-hosted': 'OpenAI-compatible · remote · not used',
			},
			everyTooltipNamesBoth: true,
			anythingSaysVerified: false,
		});
	});

	test('R-17: a LAN endpoint needs its own opt-in, and turning strict-local off does not grant it; with strict-local off, cloud-backed and unidentified models are used and still labelled', async () => {
		const lan = await observe({ allowLan: true });
		const loose = await observe({ strictLocal: false });
		const both = await observe({ strictLocal: false, allowLan: true });
		assert.deepStrictEqual({
			lan: { used: lan.used, details: lan.details['coder-lan'] },
			loose: { used: loose.used, lanStill: loose.outcomes['coder-lan'], cloudDetail: loose.details['coder:480b-cloud'] },
			both: { used: both.used, reached: both.reachedTheRuntime.length },
		}, {
			lan: { used: ['coder:7b', 'coder-lan'], details: 'vLLM · LAN' },
			loose: { used: ['coder:7b', 'coder:480b-cloud', 'coder-proxy', 'coder-hosted'], lanStill: 'refused: lan', cloudDetail: 'Ollama · cloud-backed' },
			both: { used: ['coder:7b', 'coder:480b-cloud', 'coder-lan', 'coder-proxy', 'coder-hosted'], reached: 5 },
		});
	});

	test('transport is read off the address; the decision keeps LAN and strict-local apart; no description claims to have verified anything', () => {
		const transports = Object.fromEntries([
			'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'http://box.localhost:8000/v1',
			'http://192.168.1.20:8000/v1', 'http://10.0.0.5/v1', 'http://172.20.1.1/v1', 'http://100.101.102.103:11434/v1', 'http://gpubox:11434/v1', 'http://studio.local:1234/v1', 'http://[fd12:3456::1]:8000/v1',
			'https://api.example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'not a url',
		].map(url => [url, classifyTransport(url)]));
		const strict = { strictLocal: true, allowLan: false };
		const words = [
			describeTransport('loopback'), describeTransport('lan'), describeTransport('remote'),
			describeExecution({ transport: 'loopback', execution: 'local' }, 'Ollama'), describeExecution({ transport: 'loopback', execution: 'cloud', remoteHost: 'https://ollama.com:443' }, 'Ollama'), describeExecution({ transport: 'loopback', execution: 'unknown' }, 'The server'),
			describeRefusal('lan-not-enabled'), describeRefusal('remote-transport'), describeRefusal('cloud-execution'), describeRefusal('unknown-execution'),
		].join(' ');
		assert.deepStrictEqual({
			transports,
			decisions: {
				loopbackLocal: decideInferenceUse({ transport: 'loopback', execution: 'local' }, strict),
				loopbackCloud: decideInferenceUse({ transport: 'loopback', execution: 'cloud' }, strict),
				loopbackUnknown: decideInferenceUse({ transport: 'loopback', execution: 'unknown' }, strict),
				lanLocal: decideInferenceUse({ transport: 'lan', execution: 'local' }, strict),
				lanLocalOptedIn: decideInferenceUse({ transport: 'lan', execution: 'local' }, { ...strict, allowLan: true }),
				lanLocalLoose: decideInferenceUse({ transport: 'lan', execution: 'local' }, { strictLocal: false, allowLan: false }),
				remoteLoose: decideInferenceUse({ transport: 'remote', execution: 'unknown' }, { strictLocal: false, allowLan: false }),
			},
			badges: [locationBadge({ transport: 'loopback', execution: 'local' }), locationBadge({ transport: 'lan', execution: 'local' }), locationBadge({ transport: 'loopback', execution: 'cloud' }), locationBadge({ transport: 'loopback', execution: 'unknown' }), locationBadge({ transport: 'remote', execution: 'unknown' })],
			claimsVerification: /verif|guarantee|100%|proven|certif/i.test(words),
			saysWhatItCannotKnow: /cannot establish/.test(words),
		}, {
			transports: {
				'http://localhost:11434/v1': 'loopback', 'http://127.0.0.1:1234/v1': 'loopback', 'http://[::1]:8080/v1': 'loopback', 'http://box.localhost:8000/v1': 'loopback',
				'http://192.168.1.20:8000/v1': 'lan', 'http://10.0.0.5/v1': 'lan', 'http://172.20.1.1/v1': 'lan', 'http://100.101.102.103:11434/v1': 'lan', 'http://gpubox:11434/v1': 'lan', 'http://studio.local:1234/v1': 'lan', 'http://[fd12:3456::1]:8000/v1': 'lan',
				'https://api.example.com/v1': 'remote', 'http://8.8.8.8/v1': 'remote', 'http://172.32.0.1/v1': 'remote', 'not a url': 'remote',
			},
			decisions: {
				loopbackLocal: { allowed: true },
				loopbackCloud: { allowed: false, refusal: 'cloud-execution' },
				loopbackUnknown: { allowed: false, refusal: 'unknown-execution' },
				lanLocal: { allowed: false, refusal: 'lan-not-enabled' },
				lanLocalOptedIn: { allowed: true },
				lanLocalLoose: { allowed: false, refusal: 'lan-not-enabled' },
				remoteLoose: { allowed: true },
			},
			badges: [undefined, 'LAN', 'cloud-backed', 'location unknown', 'remote'],
			claimsVerification: false,
			saysWhatItCannotKnow: true,
		});
	});
});
