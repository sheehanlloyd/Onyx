/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { buildFimContextHeader } from '../../browser/autocomplete/onyxInlineCompletions.js';
import { OnyxMemoryService } from '../../browser/intelligence/onyxMemoryService.js';

suite('OnyxMemoryAndFimContext', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('memory service', () => {

		test('notes persist through storage and re-learning a fact refreshes it', () => {
			const storage = store.add(new InMemoryStorageService());
			const service = store.add(new OnyxMemoryService(storage));
			service.addNote('tests run with scripts/test.sh');
			service.addNote('the build needs Node 24');
			service.addNote('Tests run with   scripts/test.sh'); // same fact, different spacing/case
			assert.deepStrictEqual(service.getNotes().map(note => note.text), [
				'the build needs Node 24',
				'Tests run with   scripts/test.sh',
			]);

			const reloaded = store.add(new OnyxMemoryService(storage));
			assert.strictEqual(reloaded.getNotes().length, 2);
		});

		test('empty notes are ignored and clear empties everything', () => {
			const service = store.add(new OnyxMemoryService(store.add(new InMemoryStorageService())));
			service.addNote('   ');
			assert.strictEqual(service.getNotes().length, 0);
			service.addNote('a fact');
			service.clear();
			assert.strictEqual(service.getNotes().length, 0);
		});

		test('note count is capped at 50, oldest dropped first', () => {
			const service = store.add(new OnyxMemoryService(store.add(new InMemoryStorageService())));
			for (let i = 0; i < 55; i++) {
				service.addNote(`fact number ${i}`);
			}
			const notes = service.getNotes();
			assert.strictEqual(notes.length, 50);
			assert.strictEqual(notes[0].text, 'fact number 5');
		});
	});

	suite('buildFimContextHeader', () => {

		test('renders commented sections and a trailing separator', () => {
			const header = buildFimContextHeader([{ path: 'src/util.ts', content: 'export function id(x) {\n\treturn x;\n}' }], '//', 1000);
			assert.strictEqual(header, '// Context from src/util.ts:\n// export function id(x) {\n// \treturn x;\n// }\n\n');
		});

		test('respects the character cap without splitting a line', () => {
			const long = Array.from({ length: 50 }, (_, i) => `line number ${i}`).join('\n');
			const header = buildFimContextHeader([{ path: 'a.py', content: long }], '#', 200);
			assert.ok(header.length <= 210); // cap + section framing
			assert.ok(header.split('\n').every(line => line === '' || line.startsWith('#')));
		});

		test('no sections means an empty header', () => {
			assert.strictEqual(buildFimContextHeader([], '//', 1000), '');
		});
	});
});
