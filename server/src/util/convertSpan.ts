import type { Position } from 'vscode-languageserver-types';
import { lowerBoundBinarySearch } from './lowerBoundBinarySearch';

export function convertSpan (utf8_offset: number, lineBreaks: Array<number>): Position {
	const lineBreakIndex = lowerBoundBinarySearch(lineBreaks, utf8_offset);

	const start_of_line_offset = lineBreakIndex == -1 ? 0 : lineBreaks[ lineBreakIndex ] + 1;
	const character = Math.max(0, utf8_offset - start_of_line_offset);

	return { line: lineBreakIndex + 1, character };
}
