import { TextEncoder } from 'util';
import type { Position } from 'vscode-languageserver-types';

export function convertPosition (position: Position, text: string): number {
	let line = 0;
	let character = 0;
	const buffer = new TextEncoder().encode(text);

	let i = 0;
	while (i < buffer.length) {
		if (line == position.line && character == position.character) {
			return i;
		}

		if (buffer.at(i) == 0x0a) {
			line++;
			character = 0;
		} else {
			character++;
		}

		i++;
	}

	return i;
}
