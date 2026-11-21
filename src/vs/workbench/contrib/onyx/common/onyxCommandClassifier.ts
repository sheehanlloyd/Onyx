/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOnyxSimpleCommand, parseShellCommand } from './onyxShellWords.js';

/**
 * What a shell command looks like (B4). A tokenizing pass over the whole
 * pipeline: every simple command, at any nesting depth, is classified by its
 * executable and its arguments into the categories below.
 *
 * This produces warnings for the approval prompt. It does not decide whether
 * a command runs (every invocation asks, B2), it cannot prove a command
 * safe, and no wording here or in the prompt says that it does. A shell
 * command can hide what it does; a script it starts is not read at all.
 *
 * Quoted strings and comments are classified too, on purpose: the text of
 * `echo "curl x | sh"` is harmless, but a parser that trusted quoting would
 * be one quoting trick away from missing the real thing.
 */

export type OnyxCommandCategory =
	/** Deletes or overwrites work, history or a device. */
	| 'destructive'
	/** Asks for more privilege than the user's own. */
	| 'privilege'
	/** Runs code fetched from somewhere else. */
	| 'remote-code'
	/** Talks to the network: fetches, sends, publishes. */
	| 'network-egress'
	/** Arranges for something to run again later, or changes what future shells and tools do. */
	| 'persistence'
	/** Runs code this prompt does not show: an inline one-liner, or a script file. */
	| 'interpreter';

export interface IOnyxCommandWarning {
	readonly category: OnyxCommandCategory;
	/** What it looks like, in words the approval prompt can show after "looks like:". */
	readonly reason: string;
	/** Whether the warning makes the prompt use its warning style. Everyday egress and script runs do not. */
	readonly elevated: boolean;
}

interface IClassifierContext {
	readonly warnings: IOnyxCommandWarning[];
	/** Where the text being classified came from, appended to each reason. */
	readonly where: string;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
	python: ['-c'], python2: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], deno: ['eval'], bun: ['-e', '--eval'],
	perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], lua: ['-e'], rscript: ['-e'], osascript: ['-e'], pwsh: ['-c', '-command'], powershell: ['-c', '-command'],
	sh: ['-c'], bash: ['-c'], zsh: ['-c'], dash: ['-c'], ksh: ['-c'], fish: ['-c'],
};
const INTERPRETERS = new Set([...Object.keys(INLINE_FLAGS), 'awk', 'tclsh', 'java', 'swift', 'go', 'tsx', 'ts-node']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'aria2c']);
const RAW_NETWORK = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'sftp', 'scp', 'ssh', 'rsync', 'mail', 'mailx', 'sendmail', 'msmtp', 'tftp']);
const NETWORK_CLIENTS = new Set(['gh', 'aws', 'gcloud', 'az', 'kubectl', 'heroku', 'vercel', 'netlify', 'firebase', 'dig', 'nslookup', 'host', 'ping', 'whois']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pipx']);
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec']);
/** Wrappers that run the command given after their own options. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'caffeinate', 'stdbuf', 'builtin', 'xargs', 'watch', 'unbuffer', 'setsid', 'ionice', 'chrt']);
const RC_FILES = /(^|\/)(\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile|inputrc|gitconfig|npmrc|netrc|ssh\/(authorized_keys|config|rc))|\.config\/fish\/config\.fish)$/;
const PERSISTENT_PATHS = /(Library\/Launch(Agents|Daemons)\/|\/etc\/(cron|periodic|launchd|profile|rc\.)|\.git\/hooks\/|\/etc\/sudoers)/;
const URL = /\b(?:https?|ftp|wss?):\/\/(?<host>[^\s/'"`<>)]+)/i;

function executableName(word: string): string {
	const base = word.slice(word.lastIndexOf('/') + 1).toLowerCase();
	return base.replace(/\.(exe|sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts)$/, match => match === '.exe' ? '' : match);
}

function isLoopback(host: string): boolean {
	const name = host.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/^[^@]*@/, '').toLowerCase();
	return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0' || name.endsWith('.localhost');
}

function hasFlag(words: readonly string[], short: string, long?: string): boolean {
	return words.some(word => (long !== undefined && (word === long || word.startsWith(`${long}=`))) || (/^-[A-Za-z]+$/.test(word) && word.includes(short)));
}

function add(context: IClassifierContext, category: OnyxCommandCategory, reason: string, elevated = true): void {
	const text = `${reason}${context.where}`;
	if (!context.warnings.some(existing => existing.category === category && existing.reason === text)) {
		context.warnings.push({ category, reason: text, elevated });
	}
}

/** Strips wrappers and leading assignments: `sudo -u x env A=1 nice rm -rf .` is classified as `rm -rf .`, with the privilege noted. */
function unwrap(words: readonly string[], context: IClassifierContext): readonly string[] {
	let rest = [...words];
	for (let guard = 0; guard < 8 && rest.length > 0; guard++) {
		const name = executableName(rest[0]);
		if (PRIVILEGE.has(name)) {
			add(context, 'privilege', `requests more privilege (${name})`);
			rest = rest.slice(1);
			while (rest.length && rest[0].startsWith('-')) {
				// Options that take a value: -u user, -g group, -c class.
				rest = rest.slice(/^-[ugcCphrtT]$/.test(rest[0]) ? 2 : 1);
			}
			continue;
		}
		if (WRAPPERS.has(name)) {
			rest = rest.slice(1);
			// The wrapper's own options, their numeric values (`nice -n 5`, `timeout 30s`) and `env` assignments.
			while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || /^\d+(\.\d+)?[smhd]?$/.test(rest[0]))) {
				rest = rest.slice(1);
			}
			continue;
		}
		break;
	}
	return rest;
}

function classifyGit(args: readonly string[], context: IClassifierContext): void {
	const sub = args.find(word => !word.startsWith('-')) ?? '';
	const rest = args.slice(args.indexOf(sub) + 1);
	switch (sub) {
		case 'push':
			add(context, 'network-egress', 'sends commits to a remote (git push)', false);
			if (rest.some(word => word === '--force' || word === '-f' || word.startsWith('--force-with-lease') || /^\+\S/.test(word) || word === '--mirror' || word === '--delete' || word === '-d')) {
				add(context, 'destructive', 'force-pushes over or deletes remote history');
			}
			break;
		case 'fetch': case 'pull': case 'clone': case 'ls-remote':
			add(context, 'network-egress', `contacts a git remote (git ${sub})`, false);
			break;
		case 'submodule':
			if (rest.includes('update') || rest.includes('add')) {
				add(context, 'network-egress', 'contacts a git remote (git submodule)', false);
			}
			break;
		case 'reset':
			if (rest.includes('--hard')) {
				add(context, 'destructive', 'discards uncommitted work (git reset --hard)');
			}
			break;
		case 'clean':
			if (rest.some(word => /^-[a-zA-Z]*f/.test(word) || word === '--force')) {
				add(context, 'destructive', 'deletes untracked files (git clean -f)');
			}
			break;
		case 'checkout': case 'restore':
			if (rest.includes('--') || rest.includes('.') || sub === 'restore' || rest.includes('-f') || rest.includes('--force')) {
				add(context, 'destructive', `discards uncommitted changes (git ${sub})`);
			}
			break;
		case 'branch':
			if (rest.some(word => word === '-D' || word === '--delete' || /^-[a-zA-Z]*D/.test(word))) {
				add(context, 'destructive', 'deletes a branch without a merge check (git branch -D)');
			}
			break;
		case 'stash':
			if (rest.includes('drop') || rest.includes('clear')) {
				add(context, 'destructive', 'discards stashed work (git stash drop/clear)');
			}
			break;
		case 'config':
			if (rest.includes('--global') || rest.includes('--system')) {
				add(context, 'persistence', 'changes git configuration for every repository');
			}
			break;
		case 'filter-branch': case 'filter-repo':
			add(context, 'destructive', 'rewrites history');
			break;
	}
}

function classifyPackageManager(name: string, args: readonly string[], context: IClassifierContext): void {
	const sub = args.find(word => !word.startsWith('-')) ?? '';
	if (sub === 'publish') {
		add(context, 'network-egress', 'publishes a package to a registry');
		return;
	}
	if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'up', 'dlx', 'create', 'init'].includes(sub) || (name === 'yarn' && sub === '')) {
		add(context, 'network-egress', `contacts a package registry (${name} ${sub || 'install'})`, false);
		if (sub === 'dlx' || sub === 'create' || sub === 'init') {
			add(context, 'remote-code', `fetches a package and runs it (${name} ${sub})`);
		}
		return;
	}
	if (['run', 'test', 'start', 'exec', 't', 'x', 'run-script', 'build', 'lint'].includes(sub) || (name !== 'npm' && sub && !sub.startsWith('-'))) {
		add(context, 'interpreter', `runs a script the repository defines (${name} ${sub}); this prompt does not show it`, false);
	}
}

/** Text handed to an interpreter as code: scanned for the plainest signs of what it does. */
function classifyInlineCode(code: string, language: string, context: IClassifierContext): void {
	if (/\b(rmtree|unlink|rmdir|remove\(|removedirs|rm\s+-|fs\.rm|rimraf|truncate|shutil\.move|os\.remove|File\.delete|Remove-Item|del\s)/i.test(code)) {
		add(context, 'destructive', `inline ${language} code that deletes files`);
	}
	if (/\b(urllib|requests\.|http\.client|socket\.|fetch\(|https?\.(get|request)|XMLHttpRequest|Net::HTTP|open-uri|curl|wget|Invoke-WebRequest|LWP::)|https?:\/\//i.test(code)) {
		add(context, 'network-egress', `inline ${language} code that uses the network`);
	}
	if (/\b(os\.system|subprocess|child_process|exec\(|execSync|spawn\(|popen|system\(|eval\(|do shell script|Kernel\.exec|`[^`]+`)/i.test(code)) {
		add(context, 'interpreter', `inline ${language} code that starts other commands`);
	}
}

function classifyTargets(command: IOnyxSimpleCommand, name: string, args: readonly string[], context: IClassifierContext): void {
	const written = [
		...command.redirections.filter(redirection => redirection.operator.includes('>')).map(redirection => redirection.target),
		...(['tee', 'cp', 'mv', 'ln', 'install', 'ditto'].includes(name) ? args.filter(word => !word.startsWith('-')) : []),
	];
	for (const target of written) {
		if (RC_FILES.test(target) || PERSISTENT_PATHS.test(target)) {
			add(context, 'persistence', `writes to ${target}, which later shells or tools read`);
		}
		if (/^\/dev\/(sd|disk|rdisk|nvme|hd)/.test(target)) {
			add(context, 'destructive', `writes to a raw disk device (${target})`);
		}
	}
	for (const redirection of command.redirections) {
		if (/^\/dev\/(tcp|udp)\//.test(redirection.target)) {
			add(context, 'network-egress', `opens a network connection through ${redirection.target}`);
		}
	}
}

function classifySimple(command: IOnyxSimpleCommand, all: readonly IOnyxSimpleCommand[], index: number, context: IClassifierContext): void {
	const words = unwrap(command.words, context);
	if (words.length === 0) {
		classifyTargets(command, '', [], context);
		return;
	}
	const name = executableName(words[0]);
	const args = words.slice(1);
	classifyTargets(command, name, args, context);

	// --- destructive ---------------------------------------------------------
	if (name === 'rm' || name === 'rmdir' || name === 'unlink' || name === 'shred' || name === 'srm') {
		const recursive = hasFlag(args, 'r', '--recursive') || hasFlag(args, 'R');
		const forced = hasFlag(args, 'f', '--force');
		const broad = args.some(word => word === '/' || word === '~' || word === '~/' || word === '.' || word === './' || word === '*' || word === '/*' || word === '~/*' || word === '$HOME' || word === '..');
		if (recursive || forced || name === 'shred' || name === 'srm') {
			add(context, 'destructive', `recursive or forced delete (${name}${recursive ? ' -r' : ''}${forced ? ' -f' : ''})`);
		}
		if (broad) {
			add(context, 'destructive', 'delete targets the home directory, the current directory or the filesystem root');
		}
	}
	if (name === 'find' && (args.includes('-delete') || (args.includes('-exec') && args.some(word => executableName(word) === 'rm')))) {
		add(context, 'destructive', 'deletes every file a search finds (find -delete)');
	}
	if (name === 'rimraf' || name === 'del-cli' || name === 'trash') {
		add(context, 'destructive', `deletes files recursively (${name})`);
	}
	if (name === 'dd' && args.some(word => /^of=\/dev\//.test(word))) {
		add(context, 'destructive', 'writes raw bytes to a device (dd of=/dev/…)');
	}
	if (/^mkfs(\.|$)/.test(name) || (name === 'diskutil' && args.some(word => /^(erase|partition|reformat|zeroDisk|secureErase)/i.test(word))) || name === 'fdisk' || name === 'parted') {
		add(context, 'destructive', 'formats or repartitions a disk');
	}
	if (name === 'shutdown' || name === 'reboot' || name === 'halt' || name === 'poweroff') {
		add(context, 'destructive', 'shuts down or restarts the machine');
	}
	if ((name === 'kill' && args.includes('-1')) || name === 'killall' || (name === 'pkill' && args.length > 0)) {
		add(context, 'destructive', 'kills processes by pattern or all at once');
	}
	if (name === 'chmod' && args.some(word => /^0?777$/.test(word) || word === 'a+rwx' || /\+s/.test(word))) {
		add(context, /\+s/.test(args.join(' ')) ? 'privilege' : 'destructive', 'makes files world-writable or setuid (chmod)');
	}
	if (name === 'truncate' || (name === 'history' && args.includes('-c')) || (name === 'unset' && args.includes('HISTFILE'))) {
		add(context, 'destructive', name === 'truncate' ? 'truncates files' : 'clears shell history');
	}
	if (name === 'git') {
		classifyGit(args, context);
	}

	// --- persistence ---------------------------------------------------------
	if (name === 'crontab') {
		add(context, 'persistence', 'changes scheduled jobs (crontab)');
		if (args.includes('-r')) {
			add(context, 'destructive', 'removes every scheduled job (crontab -r)');
		}
	}
	if (name === 'at' || name === 'batch') {
		add(context, 'persistence', 'schedules a command to run later');
	}
	if ((name === 'launchctl' && args.some(word => /^(load|unload|bootstrap|bootout|enable|disable|submit|kickstart)$/.test(word))) || (name === 'systemctl' && args.some(word => /^(enable|disable|mask|unmask|daemon-reload)$/.test(word)))) {
		add(context, 'persistence', 'changes system services');
	}
	if ((name === 'defaults' && args.includes('write')) || name === 'scutil' || name === 'nvram' || name === 'spctl' || name === 'csrutil') {
		add(context, 'persistence', 'changes system settings');
	}

	// --- network egress ------------------------------------------------------
	if (DOWNLOADERS.has(name)) {
		const uploads = args.some(word => /^(-d|--data|--data-binary|--data-raw|--data-urlencode|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--body-file|--json)(=|$)/.test(word) || /^-[A-Za-z]*[dFT]$/.test(word))
			|| args.some((word, position) => (word === '-X' || word === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[position + 1] ?? ''))
			|| args.some(word => word.startsWith('@'));
		add(context, 'network-egress', uploads ? `sends data to a remote host (${name})` : `fetches from a remote host (${name})`, uploads);
	}
	if (RAW_NETWORK.has(name)) {
		add(context, 'network-egress', `opens a connection to another machine (${name})`);
	}
	if (NETWORK_CLIENTS.has(name)) {
		add(context, 'network-egress', `talks to a remote service (${name})`, false);
	}
	if (name === 'docker' || name === 'podman') {
		const sub = args.find(word => !word.startsWith('-')) ?? '';
		if (['push', 'pull', 'login', 'run', 'build'].includes(sub)) {
			add(context, sub === 'run' ? 'interpreter' : 'network-egress', sub === 'run' ? 'runs a container image; this prompt does not show what is in it' : `contacts a container registry (${name} ${sub})`, sub === 'push');
		}
	}
	if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
		classifyPackageManager(name, args, context);
	}
	if (['pip', 'pip3', 'brew', 'gem', 'cargo', 'go', 'apt', 'apt-get', 'port', 'uv', 'poetry', 'conda', 'composer'].includes(name) && args.some(word => /^(install|add|get|update|upgrade|sync|publish|upload)$/.test(word))) {
		add(context, 'network-egress', `contacts a package registry (${name})`, args.some(word => word === 'publish' || word === 'upload'));
	}
	if (name === 'open' || name === 'xdg-open') {
		const target = args.find(word => URL.test(word));
		if (target) {
			add(context, 'network-egress', 'opens a URL in the browser');
		}
	}
	for (const word of [...words, ...command.redirections.map(redirection => redirection.target)]) {
		const match = URL.exec(word);
		if (match?.groups && !isLoopback(match.groups.host) && !context.warnings.some(warning => warning.category === 'network-egress' && warning.reason.endsWith(context.where))) {
			add(context, 'network-egress', `names a remote host (${match.groups.host.replace(/^[^@]*@/, '')})`, false);
		}
	}

	// --- remote code ---------------------------------------------------------
	if (PACKAGE_RUNNERS.has(name) || (name === 'pipx' && args[0] === 'run')) {
		add(context, 'remote-code', `fetches a package and runs it (${name})`);
		const inner = args.filter(word => !word.startsWith('-'));
		if (inner.length) {
			classifySimple({ ...command, words: inner, redirections: [] }, all, index, context);
		}
	}
	const fed = pipelineBefore(all, index);
	const runsInput = SHELLS.has(name) || INTERPRETERS.has(name) || name === 'source' || name === '.' || name === 'eval';
	if (runsInput && fed.some(previous => DOWNLOADERS.has(executableName(unwrap(previous.words, { warnings: [], where: '' })[0] ?? '')))) {
		add(context, 'remote-code', `pipes downloaded content straight into ${name}`);
	}
	if (runsInput && fed.some(previous => ['base64', 'xxd', 'openssl', 'gunzip', 'zcat', 'uudecode'].includes(executableName(unwrap(previous.words, { warnings: [], where: '' })[0] ?? '')))) {
		add(context, 'remote-code', `decodes hidden content into ${name}`);
	}
	const children = all.filter(candidate => candidate.parent === index);
	if (runsInput && children.some(child => DOWNLOADERS.has(executableName(unwrap(child.words, { warnings: [], where: '' })[0] ?? '')))) {
		add(context, 'remote-code', `runs downloaded content (${name} with a download inside it)`);
	}

	// --- interpreter ---------------------------------------------------------
	if (name === 'eval') {
		add(context, 'interpreter', 'evaluates a string as a command (eval)');
	}
	const inlineFlags = INLINE_FLAGS[name.replace(/\d+(\.\d+)*$/, '')] ?? INLINE_FLAGS[name];
	if (inlineFlags) {
		const flagAt = args.findIndex(word => inlineFlags.includes(word.toLowerCase()));
		if (flagAt !== -1) {
			const code = args[flagAt + 1] ?? '';
			add(context, 'interpreter', `runs inline ${name} code`, !SHELLS.has(name));
			if (SHELLS.has(name)) {
				classifyText(code, { warnings: context.warnings, where: ` (inside ${name} -c)` });
			} else {
				classifyInlineCode(code, name, context);
			}
			return;
		}
	}
	if (INTERPRETERS.has(name) || SHELLS.has(name)) {
		const script = args.find(word => !word.startsWith('-'));
		if (script && name !== 'go' && name !== 'java' && name !== 'swift') {
			add(context, 'interpreter', `runs a script file (${script}); this prompt does not show what it does`, false);
		} else if (name === 'go' && (args[0] === 'run' || args[0] === 'generate' || args[0] === 'test')) {
			add(context, 'interpreter', `runs code the repository defines (go ${args[0]})`, false);
		} else if (!script && command.redirections.some(redirection => redirection.operator.startsWith('<'))) {
			add(context, 'interpreter', `runs ${name} on redirected input`);
		}
	}
	if (/^\.{1,2}\//.test(words[0]) || ['make', 'just', 'gradle', 'gradlew', 'mvn', 'mvnw', 'rake', 'task', 'tox', 'nox'].includes(name)) {
		add(context, 'interpreter', `runs something the repository defines (${words[0]}); this prompt does not show it`, false);
	}
}

/** The commands that feed this one through a pipe. */
function pipelineBefore(all: readonly IOnyxSimpleCommand[], index: number): IOnyxSimpleCommand[] {
	const target = all[index];
	return all.filter((candidate, position) => position < index && candidate.pipeline === target.pipeline && candidate.depth === target.depth && candidate.parent === target.parent);
}

function classifyText(text: string, context: IClassifierContext, depth = 0): void {
	if (depth > 3 || !text.trim()) {
		return;
	}
	const parsed = parseShellCommand(text);
	parsed.commands.forEach((command, index) => classifySimple(command, parsed.commands, index, context));
	// A download and a shell in one command line, in any arrangement the rules above did not name.
	const names = parsed.commands.map(command => executableName(unwrap(command.words, { warnings: [], where: '' })[0] ?? ''));
	if (names.some(name => DOWNLOADERS.has(name)) && names.some(name => SHELLS.has(name) || name === 'source' || name === '.' || name === 'eval') && !context.warnings.some(warning => warning.category === 'remote-code')) {
		add(context, 'remote-code', 'downloads something and runs a shell in the same command');
	}
	if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(text)) {
		add(context, 'destructive', 'fork bomb');
	}
	for (const quoted of parsed.quoted) {
		// Deliberate over-warning: what a quoted string says is classified as if it could run.
		if (/[|;&$`]|\b(rm|sudo|curl|wget|doas)\b/.test(quoted)) {
			classifyText(quoted, { warnings: context.warnings, where: context.where || ' (inside a quoted string)' }, depth + 1);
		}
	}
	for (const comment of parsed.comments) {
		classifyText(comment, { warnings: context.warnings, where: ' (in a comment)' }, depth + 1);
	}
	for (const body of parsed.heredocs) {
		classifyText(body, { warnings: context.warnings, where: ' (in a here-document)' }, depth + 1);
	}
	if (depth === 0) {
		// Only for the command itself: quoted text and comments are prose more often than shell.
		for (const problem of parsed.problems) {
			add(context, 'interpreter', `could not be read completely: ${problem}`);
		}
	}
}

/** Every warning the command earns, in the order found. An empty list means nothing was recognized, not that the command is harmless. */
export function classifyShellCommand(command: string): readonly IOnyxCommandWarning[] {
	const context: IClassifierContext = { warnings: [], where: '' };
	classifyText(command, context);
	return context.warnings;
}
