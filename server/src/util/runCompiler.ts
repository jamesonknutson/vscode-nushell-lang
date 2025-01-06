import type * as fs from 'fs';
import { undefined } from '../server';
import type { NushellIDESettings } from '../settings';
import { connection, exec, tmpFile } from '../settings';
import { includeFlagForPath } from './includeFlagForPath';


export async function runCompiler (
	text: string, // this is the script or the snippet of nushell code
	flags: string,
	settings: NushellIDESettings,
	uri: string,
	options: { allowErrors?: boolean; label: string; } = { label: 'runCompiler' }
): Promise<string> {
	const allowErrors = options.allowErrors === undefined ? true : options.allowErrors;

	try {
		fs.writeFileSync(tmpFile.name, text);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (e: any) {
		connection.console.error(`[${options.label}] error writing to tmp file: ${e}`);
	}

	let stdout = '';
	try {
		const script_path_flag = includeFlagForPath(uri) +
			'\x1e' + // \x1e is the record separator character (a character that is unlikely to appear in a path)
			settings.includeDirs.join('\x1e') +
			'"';

		const max_errors = settings.maxNumberOfProblems;

		if (flags.includes('ide-check')) {
			flags = flags + ' ' + max_errors;
		}

		connection.console.log(
			`[${options.label}] running: ${settings.nushellExecutablePath} ${flags} ${script_path_flag} ${tmpFile.name}`
		);

		const output = await exec(`${settings.nushellExecutablePath} ${flags} ${script_path_flag} ${tmpFile.name}`, {
			timeout: settings.maxNushellInvocationTime,
		});
		stdout = output.stdout;
		console.log(`[${options.label}] stdout: ${stdout}`);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (e: any) {
		stdout = e.stdout;
		connection.console.log(`[${options.label}] compile failed: ` + e);
		if (!allowErrors) {
			throw e;
		}
	}

	return stdout;
}
