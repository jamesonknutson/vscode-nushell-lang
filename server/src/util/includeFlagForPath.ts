import * as path from 'path';
import { URI } from 'vscode-uri';

export function includeFlagForPath (file_path: string): string {
	const parsed = URI.parse(file_path);
	if (parsed.scheme === 'file') {
		return '-I ' + '"' + path.dirname(parsed.fsPath);
	}
	return '-I ' + '"' + file_path;
}
