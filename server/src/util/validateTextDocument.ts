import { type Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { InlayHint, InlayHintKind, InlayHintLabelPart } from 'vscode-languageserver-types';
import { connection, getDocumentSettings, hasDiagnosticRelatedInformationCapability, type NuTextDocument } from '../settings';
import { convertSpan } from './convertSpan';
import { durationLogWrapper } from './durationLogWrapper';
import findLineBreaks from './findLineBreaks';
import { runCompiler } from './runCompiler';

export async function validateTextDocument (textDocument: NuTextDocument): Promise<void> {
	return await durationLogWrapper(`validateTextDocument ${textDocument.uri}`, async (label) => {
		if (!hasDiagnosticRelatedInformationCapability) {
			console.error('Trying to validate a document with no diagnostic capability');
			return;
		}

		// In this simple example we get the settings for every validate run.
		const settings = await getDocumentSettings(textDocument.uri);

		// The validator creates diagnostics for all uppercase words length 2 and more
		const text = textDocument.getText();
		const lineBreaks = findLineBreaks(text);

		const stdout = await runCompiler(text, '--ide-check', settings, textDocument.uri, { label: label });

		textDocument.nuInlayHints = [];
		const diagnostics: Diagnostic[] = [];

		// FIXME: We use this to deduplicate type hints given by the compiler.
		//        It'd be nicer if it didn't give duplicate hints in the first place.
		const seenTypeHintPositions = new Set();

		const lines = stdout.split('\n').filter((l) => l.length > 0);
		for (const line of lines) {
			connection.console.log('line: ' + line);
			try {
				const obj = JSON.parse(line);

				if (obj.type == 'diagnostic') {
					let severity: DiagnosticSeverity = DiagnosticSeverity.Error;

					switch (obj.severity) {
						case 'Information':
							severity = DiagnosticSeverity.Information;
							break;
						case 'Hint':
							severity = DiagnosticSeverity.Hint;
							break;
						case 'Warning':
							severity = DiagnosticSeverity.Warning;
							break;
						case 'Error':
							severity = DiagnosticSeverity.Error;
							break;
					}

					const position_start = convertSpan(obj.span.start, lineBreaks);
					const position_end = convertSpan(obj.span.end, lineBreaks);

					const diagnostic: Diagnostic = {
						severity,
						range: {
							start: position_start,
							end: position_end,
						},
						message: obj.message,
						source: textDocument.uri,
					};

					// connection.console.log(diagnostic.message);
					diagnostics.push(diagnostic);
				} else if (obj.type == 'hint' && settings.hints.showInferredTypes) {
					if (!seenTypeHintPositions.has(obj.position)) {
						seenTypeHintPositions.add(obj.position);
						const position = convertSpan(obj.position.end, lineBreaks);
						const hint_string = ': ' + obj.typename;
						const hint = InlayHint.create(position, [ InlayHintLabelPart.create(hint_string) ], InlayHintKind.Type);

						textDocument.nuInlayHints.push(hint);
					}
				}
			} catch (e) {
				connection.console.error(`error: ${e}`);
			}
		}

		// Send the computed diagnostics to VSCode.
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	});
}
