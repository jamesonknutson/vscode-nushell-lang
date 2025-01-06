import { TextEncoder } from 'util';

export function findLineBreaks (utf16_text: string): Array<number> {
	const utf8_text = new TextEncoder().encode(utf16_text);
	const lineBreaks: Array<number> = [];

	for (let i = 0; i < utf8_text.length; ++i) {
		if (utf8_text[ i ] == 0x0a) {
			lineBreaks.push(i);
		}
	}

	return lineBreaks;
}

export default findLineBreaks;