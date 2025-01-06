import type * as child_process from 'node:child_process'
import type * as util from 'node:util'
import type * as tmp from 'tmp'
import { ProposedFeatures, TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { InlayHint } from 'vscode-languageserver-types'
import { createConnection } from 'vscode-languageserver/node'

// The nushell settings
export interface NushellIDESettings {
	maxNumberOfProblems: number
	hints: {
		showInferredTypes: boolean
	}
	nushellExecutablePath: string
	maxNushellInvocationTime: number
	includeDirs: string[]
}export let hasDiagnosticRelatedInformationCapability = false
export let hasWorkspaceFolderCapability = false
export let hasConfigurationCapability = false
// Create a simple text document manager.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)
// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
export const defaultSettings: NushellIDESettings = {
	maxNumberOfProblems: 1000,
	hints: { showInferredTypes: true },
	nushellExecutablePath: 'nu',
	maxNushellInvocationTime: 10000000,
	includeDirs: [],
}
export let globalSettings: NushellIDESettings = defaultSettings
// Cache the settings of all open documents
export const documentSettings: Map<string, Thenable<NushellIDESettings>> = new Map()
export function getDocumentSettings (resource: string): Thenable<NushellIDESettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings)
	}
	let result = documentSettings.get(resource)
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'nushellLanguageServer',
		})
		documentSettings.set(resource, result)
	}
	return result
}
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.

export const connection = createConnection(ProposedFeatures.all)
export const tmpFile = tmp.fileSync({ prefix: 'nushell', keep: false })
export const exec = util.promisify(child_process.exec)
export interface NuTextDocument extends TextDocument {
	nuInlayHints?: InlayHint[]
}

