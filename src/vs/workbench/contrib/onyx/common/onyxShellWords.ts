/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small shell-word parser (B4). It splits a command line into the simple
 * commands a POSIX shell would run: across pipes, lists and newlines, inside
 * command and process substitutions, subshells and groups. Each simple
 * command comes back as unquoted words plus its redirections, so a classifier
 * can look at the executable and its arguments instead of matching a regular
 * expression against the whole string.
 *
 * It is a reader, not a shell. Nothing is expanded: `$HOME`, globs and
 * aliases stay as text, and a construct it cannot follow is reported as a
 * problem rather than guessed at. The text of every quoted string and of
 * every comment is kept, so the classifier can deliberately over-warn on
 * what they contain.
 */

export interface IOnyxShellRedirection {
	/** `>`, `>>`, `<`, `<<`, `<<<`, `>&`, `&>`, `<>`, with any leading descriptor removed. */
	readonly operator: string;
	readonly target: string;
}

export interface IOnyxSimpleCommand {
	/** Leading `NAME=value` assignments, unquoted. */
	readonly assignments: readonly string[];
	/** The command's words, unquoted: the executable first. Empty for a bare assignment or redirection. */
	readonly words: readonly string[];
	readonly redirections: readonly IOnyxShellRedirection[];
	/** What separates this command from the one before it: `start`, `|`, `|&`, `&&`, `||`, `;`, `&` or `newline`. */
	readonly precededBy: string;
	/** 0 at the top level; one more for each substitution, subshell or group it sits in. */
	readonly depth: number;
	/** How the command is nested: `top`, `$()`, a backtick substitution, `<()`, `>()`, `()` or `{}`. */
	readonly context: string;
	/** The index, in the returned list, of the command whose word contains this one; -1 at the top level. */
	readonly parent: number;
	/** The index of the pipeline this command belongs to; commands joined by `|` share it. */
	readonly pipeline: number;
}

export interface IOnyxParsedShellCommand {
	readonly commands: readonly IOnyxSimpleCommand[];
	/** The content of every single- or double-quoted string, in order. */
	readonly quoted: readonly string[];
	/** The text of every comment, without its `#`. */
	readonly comments: readonly string[];
	/** Here-document bodies, in order. */
	readonly heredocs: readonly string[];
	/** Why the parse is incomplete: an unterminated quote or substitution. Empty for a clean parse. */
	readonly problems: readonly string[];
}

interface IMutableCommand {
	assignments: string[];
	words: string[];
	redirections: IOnyxShellRedirection[];
	precededBy: string;
	depth: number;
	context: string;
	parent: number;
	pipeline: number;
}

const MAX_DEPTH = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const OPERATOR_START = new Set(['|', '&', ';', '(', ')', '<', '>', '\n']);

class ShellReader {

	readonly commands: IMutableCommand[] = [];
	readonly quoted: string[] = [];
	readonly comments: string[] = [];
	readonly heredocs: string[] = [];
	readonly problems: string[] = [];
	private _pipeline = 0;

	parse(text: string, depth: number, context: string, parent: number): void {
		if (depth > MAX_DEPTH) {
			this.problems.push('nested too deeply to read');
			return;
		}
		let position = 0;
		let current: IMutableCommand | undefined;
		let precededBy = 'start';
		let pipeline = this._pipeline++;
		const pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];

		const ensure = (): IMutableCommand => {
			if (!current) {
				current = { assignments: [], words: [], redirections: [], precededBy, depth, context, parent, pipeline };
				this.commands.push(current);
			}
			return current;
		};
		const end = (operator: string): void => {
			current = undefined;
			precededBy = operator;
			if (operator !== '|' && operator !== '|&') {
				pipeline = this._pipeline++;
			}
		};

		while (position < text.length) {
			const character = text[position];

			if (character === '\n') {
				position++;
				if (pendingHeredocs.length) {
					position = this._readHeredocs(text, position, pendingHeredocs);
				}
				end('newline');
				continue;
			}
			if (character === ' ' || character === '\t' || character === '\r') {
				position++;
				continue;
			}
			if (character === '\\' && text[position + 1] === '\n') {
				position += 2; // line continuation
				continue;
			}
			if (character === '#') {
				const lineEnd = text.indexOf('\n', position);
				const stop = lineEnd === -1 ? text.length : lineEnd;
				this.comments.push(text.slice(position + 1, stop));
				position = stop;
				continue;
			}

			// --- operators -----------------------------------------------------
			if (character === '|') {
				if (text[position + 1] === '|') {
					position += 2;
					end('||');
				} else if (text[position + 1] === '&') {
					position += 2;
					end('|&');
				} else {
					position++;
					end('|');
				}
				continue;
			}
			if (character === '&') {
				if (text[position + 1] === '&') {
					position += 2;
					end('&&');
					continue;
				}
				if (text[position + 1] === '>') {
					const operator = text[position + 2] === '>' ? '&>>' : '&>';
					position += operator.length;
					const target = this._readWord(text, position, depth, this.commands.indexOf(ensure()));
					position = target.end;
					ensure().redirections.push({ operator, target: target.value });
					continue;
				}
				position++;
				end('&');
				continue;
			}
			if (character === ';') {
				position += text[position + 1] === ';' ? 2 : 1;
				end(';');
				continue;
			}
			if (character === '(') {
				const close = this._matching(text, position, '(', ')');
				if (close === -1) {
					this.problems.push('an opening parenthesis is never closed');
					this.parse(text.slice(position + 1), depth + 1, '()', parent);
					return;
				}
				this.parse(text.slice(position + 1, close), depth + 1, '()', parent);
				position = close + 1;
				continue;
			}
			if (character === ')') {
				position++; // a stray close; a matched one was consumed with its open
				continue;
			}
			if (character === '<' || character === '>') {
				if (text[position + 1] === '(') {
					// Process substitution is a word, read below.
				} else {
					const read = this._readRedirection(text, position, depth, this.commands.indexOf(ensure()), pendingHeredocs);
					position = read.end;
					ensure().redirections.push(read.redirection);
					continue;
				}
			}

			// --- a word --------------------------------------------------------
			const owner = ensure();
			const word = this._readWord(text, position, depth, this.commands.indexOf(owner));
			if (word.end === position) {
				position++; // nothing consumed: skip the character so the reader always advances
				continue;
			}
			position = word.end;
			// A descriptor number glued to a redirection (`2>`, `1>&2`) belongs to the redirection.
			if (/^\d+$/.test(word.raw) && (text[position] === '<' || text[position] === '>') && text[position + 1] !== '(') {
				const read = this._readRedirection(text, position, depth, this.commands.indexOf(owner), pendingHeredocs);
				position = read.end;
				owner.redirections.push(read.redirection);
				continue;
			}
			// `NAME=value` before the command word. The name must be bare; the value may be quoted.
			if (owner.words.length === 0 && ASSIGNMENT.test(word.raw) && ASSIGNMENT.test(word.value)) {
				owner.assignments.push(word.value);
				continue;
			}
			if (owner.words.length === 0 && !word.quotedAnywhere && (word.value === '{' || word.value === '}' || RESERVED.has(word.value))) {
				// Group braces and control-flow keywords introduce commands; they are not commands themselves.
				if (word.value === '{' || word.value === '}') {
					end(precededBy === 'start' ? 'start' : ';');
				}
				continue;
			}
			owner.words.push(word.value);
		}
		if (pendingHeredocs.length) {
			this.problems.push('a here-document is never closed');
		}
	}

	private _readHeredocs(text: string, position: number, pending: { delimiter: string; stripTabs: boolean }[]): number {
		while (pending.length) {
			const { delimiter, stripTabs } = pending.shift()!;
			const lines: string[] = [];
			let closed = false;
			while (position <= text.length) {
				const lineEnd = text.indexOf('\n', position);
				const stop = lineEnd === -1 ? text.length : lineEnd;
				const line = text.slice(position, stop);
				position = lineEnd === -1 ? text.length + 1 : stop + 1;
				if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
					closed = true;
					break;
				}
				lines.push(line);
			}
			this.heredocs.push(lines.join('\n'));
			if (!closed) {
				this.problems.push('a here-document is never closed');
			}
		}
		return Math.min(position, text.length);
	}

	private _readRedirection(text: string, position: number, depth: number, owner: number, pendingHeredocs: { delimiter: string; stripTabs: boolean }[]): { redirection: IOnyxShellRedirection; end: number } {
		let operator = text[position];
		position++;
		while (position < text.length && (text[position] === '<' || text[position] === '>' || text[position] === '&' || text[position] === '|' || text[position] === '-') && operator.length < 3) {
			// `<<-` strips tabs; `-` belongs to the operator only there.
			if (text[position] === '-' && operator !== '<<') {
				break;
			}
			operator += text[position];
			position++;
		}
		while (text[position] === ' ' || text[position] === '\t') {
			position++;
		}
		const target = this._readWord(text, position, depth, owner);
		if (operator === '<<' || operator === '<<-') {
			pendingHeredocs.push({ delimiter: target.value, stripTabs: operator === '<<-' });
		}
		return { redirection: { operator, target: target.value }, end: target.end };
	}

	/** Reads one word starting at `position`: adjacent quoted and unquoted parts are one word, as in a shell. */
	private _readWord(text: string, position: number, depth: number, owner: number): { value: string; raw: string; end: number; quotedAnywhere: boolean } {
		let value = '';
		let quotedAnywhere = false;
		const start = position;
		while (position < text.length) {
			const character = text[position];
			if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
				break;
			}
			if (character === '\\') {
				if (text[position + 1] === '\n') {
					position += 2;
					continue;
				}
				if (position + 1 < text.length) {
					value += text[position + 1];
					position += 2;
					quotedAnywhere = true;
					continue;
				}
				position++;
				continue;
			}
			if (character === '\'') {
				const close = text.indexOf('\'', position + 1);
				if (close === -1) {
					this.problems.push('a single quote is never closed');
					const rest = text.slice(position + 1);
					this.quoted.push(rest);
					return { value: value + rest, raw: text.slice(start), end: text.length, quotedAnywhere: true };
				}
				const content = text.slice(position + 1, close);
				this.quoted.push(content);
				value += content;
				position = close + 1;
				quotedAnywhere = true;
				continue;
			}
			if (character === '"') {
				const read = this._readDoubleQuoted(text, position + 1, depth, owner);
				value += read.value;
				position = read.end;
				quotedAnywhere = true;
				continue;
			}
			if (character === '`') {
				const close = this._closingBacktick(text, position + 1);
				if (close === -1) {
					this.problems.push('a backtick substitution is never closed');
					this.parse(text.slice(position + 1), depth + 1, '`', owner);
					return { value: value + text.slice(position), raw: text.slice(start), end: text.length, quotedAnywhere };
				}
				this.parse(text.slice(position + 1, close).replace(/\\`/g, '`'), depth + 1, '`', owner);
				value += text.slice(position, close + 1);
				position = close + 1;
				continue;
			}
			if (character === '$' && text[position + 1] === '(') {
				if (text[position + 2] === '(') {
					const close = text.indexOf('))', position + 3);
					const stop = close === -1 ? text.length : close + 2;
					value += text.slice(position, stop); // arithmetic: not a command
					position = stop;
					continue;
				}
				const close = this._matching(text, position + 1, '(', ')');
				if (close === -1) {
					this.problems.push('a command substitution is never closed');
					this.parse(text.slice(position + 2), depth + 1, '$()', owner);
					return { value: value + text.slice(position), raw: text.slice(start), end: text.length, quotedAnywhere };
				}
				this.parse(text.slice(position + 2, close), depth + 1, '$()', owner);
				value += text.slice(position, close + 1);
				position = close + 1;
				continue;
			}
			if ((character === '<' || character === '>') && text[position + 1] === '(') {
				const close = this._matching(text, position + 1, '(', ')');
				if (close === -1) {
					this.problems.push('a process substitution is never closed');
					this.parse(text.slice(position + 2), depth + 1, `${character}()`, owner);
					return { value: value + text.slice(position), raw: text.slice(start), end: text.length, quotedAnywhere };
				}
				this.parse(text.slice(position + 2, close), depth + 1, `${character}()`, owner);
				value += text.slice(position, close + 1);
				position = close + 1;
				continue;
			}
			if (character === '$' && text[position + 1] === '{') {
				const close = text.indexOf('}', position + 2);
				const stop = close === -1 ? text.length : close + 1;
				value += text.slice(position, stop);
				position = stop;
				continue;
			}
			if (OPERATOR_START.has(character)) {
				break;
			}
			if (character === '#' && position === start) {
				break;
			}
			value += character;
			position++;
		}
		return { value, raw: text.slice(start, position), end: position, quotedAnywhere };
	}

	private _readDoubleQuoted(text: string, position: number, depth: number, owner: number): { value: string; end: number } {
		let value = '';
		while (position < text.length) {
			const character = text[position];
			if (character === '"') {
				this.quoted.push(value);
				return { value, end: position + 1 };
			}
			if (character === '\\' && position + 1 < text.length) {
				const next = text[position + 1];
				if (next === '"' || next === '\\' || next === '$' || next === '`') {
					value += next;
					position += 2;
					continue;
				}
				if (next === '\n') {
					position += 2;
					continue;
				}
				value += character;
				position++;
				continue;
			}
			if (character === '`') {
				const close = this._closingBacktick(text, position + 1);
				if (close !== -1) {
					this.parse(text.slice(position + 1, close).replace(/\\`/g, '`'), depth + 1, '`', owner);
					value += text.slice(position, close + 1);
					position = close + 1;
					continue;
				}
			}
			if (character === '$' && text[position + 1] === '(' && text[position + 2] !== '(') {
				const close = this._matching(text, position + 1, '(', ')');
				if (close !== -1) {
					this.parse(text.slice(position + 2, close), depth + 1, '$()', owner);
					value += text.slice(position, close + 1);
					position = close + 1;
					continue;
				}
			}
			value += character;
			position++;
		}
		this.problems.push('a double quote is never closed');
		this.quoted.push(value);
		return { value, end: text.length };
	}

	private _closingBacktick(text: string, position: number): number {
		while (position < text.length) {
			if (text[position] === '\\') {
				position += 2;
				continue;
			}
			if (text[position] === '`') {
				return position;
			}
			position++;
		}
		return -1;
	}

	/** The index of the `close` that matches the `open` at `position`, skipping quoted text; -1 when there is none. */
	private _matching(text: string, position: number, open: string, close: string): number {
		let level = 0;
		for (let index = position; index < text.length; index++) {
			const character = text[index];
			if (character === '\\') {
				index++;
			} else if (character === '\'') {
				const end = text.indexOf('\'', index + 1);
				if (end === -1) {
					return -1;
				}
				index = end;
			} else if (character === '"') {
				let end = index + 1;
				while (end < text.length && text[end] !== '"') {
					end += text[end] === '\\' ? 2 : 1;
				}
				if (end >= text.length) {
					return -1;
				}
				index = end;
			} else if (character === open) {
				level++;
			} else if (character === close) {
				level--;
				if (level === 0) {
					return index;
				}
			}
		}
		return -1;
	}
}

/** Control-flow words that introduce a command without being one. */
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', '!', 'time']);

export function parseShellCommand(command: string): IOnyxParsedShellCommand {
	const reader = new ShellReader();
	reader.parse(command, 0, 'top', -1);
	// Drop the empty commands a keyword or a brace left behind, and re-point each parent at its new index.
	const kept = reader.commands.map(candidate => candidate.words.length > 0 || candidate.assignments.length > 0 || candidate.redirections.length > 0);
	const remap = new Map<number, number>();
	let next = 0;
	kept.forEach((keep, index) => {
		if (keep) {
			remap.set(index, next++);
		}
	});
	return {
		commands: reader.commands.filter((_, index) => kept[index]).map(candidate => ({ ...candidate, parent: remap.get(candidate.parent) ?? -1 })),
		quoted: reader.quoted,
		comments: reader.comments,
		heredocs: reader.heredocs,
		problems: [...new Set(reader.problems)],
	};
}
