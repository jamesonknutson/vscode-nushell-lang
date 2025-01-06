import type * as fs from 'fs';
import type { Definition, HandlerResult } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { connection, tmpFile } from '../settings';
import { convertSpan } from './convertSpan';
import findLineBreaks from './findLineBreaks';

export async function goToDefinition (
	document: TextDocument,
	nushellOutput: string): Promise<HandlerResult<Definition, void> | undefined> {
	const lines = nushellOutput.split('\n').filter((l) => l.length > 0);
	for (const line of lines) {
		const obj = JSON.parse(line);
		// connection.console.log("going to type definition");
		// connection.console.log(obj);
		if (obj.file === '' || obj.file === '__prelude__') return;

		let documentText: string;
		if (obj.file) {
			if (fs.existsSync(obj.file)) {
				documentText = await fs.promises.readFile(obj.file).then((b) => b.toString());
			} else {
				connection.console.log(`File ${obj.file} does not exist`);
				return;
			}
		} else {
			documentText = document.getText();
		}

		const lineBreaks: number[] = findLineBreaks(documentText);

		let uri = '';
		if (obj.file == tmpFile.name) {
			uri = document.uri;
		} else {
			uri = obj.file ? URI.file(obj.file).toString() : document.uri;
		}

		// connection.console.log(uri);
		return {
			uri: uri,
			range: {
				start: convertSpan(obj.start, lineBreaks),
				end: convertSpan(obj.end, lineBreaks),
			},
		};
	}
}
