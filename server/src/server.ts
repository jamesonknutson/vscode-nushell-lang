/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	CompletionItem,
	CompletionItemKind,
	DidChangeConfigurationNotification,
	HoverParams,
	InitializeParams,
	InitializeResult,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node'

import * as fs from 'fs'
import { InlayHintParams } from 'vscode-languageserver-protocol'
import { connection, defaultSettings, documents, documentSettings, getDocumentSettings, globalSettings, hasConfigurationCapability, hasDiagnosticRelatedInformationCapability, hasWorkspaceFolderCapability, tmpFile, type NushellIDESettings, type NuTextDocument } from './settings'
import { debounce } from './util'
import { convertPosition } from './util/convertPosition'
import { convertSpan } from './util/convertSpan'
import { durationLogWrapper } from './util/durationLogWrapper'
import { findLineBreaks } from './util/findLineBreaks'
import { goToDefinition } from './util/goToDefinition'
import { runCompiler } from './util/runCompiler'
import { validateTextDocument } from './util/validateTextDocument'

connection.onExit(() => {
  tmpFile.removeCallback()
})

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration)
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders)
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  )

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
      inlayHintProvider: {
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
    },
  }
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    }
  }
  return result
})

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined)
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.')
    })
  }
})

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear()
  } else {
    globalSettings = <NushellIDESettings>(change.settings.nushellLanguageServer || defaultSettings)
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument)
})

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri)
})

documents.onDidChangeContent(
  (() => {
    const throttledValidateTextDocument = debounce(validateTextDocument, 500, false)

    return (change) => {
      throttledValidateTextDocument(change.document)
    }
  })()
)

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log('We received an file change event')
})

connection.onHover(async (request: HoverParams) => {
  return await durationLogWrapper(`onHover`, async () => {
    const document = documents.get(request.textDocument.uri)
    const settings = await getDocumentSettings(request.textDocument.uri)

    const text = document?.getText()

    if (!(typeof text == 'string')) return null

    // connection.console.log("request: ");
    // connection.console.log(request.textDocument.uri);
    // connection.console.log("index: " + convertPosition(request.position, text));
    const stdout = await runCompiler(
      text,
      '--ide-hover ' + convertPosition(request.position, text),
      settings,
      request.textDocument.uri
    )

    const lines = stdout.split('\n').filter((l) => l.length > 0)
    for (const line of lines) {
      const obj = JSON.parse(line)
      // connection.console.log("hovering");
      // connection.console.log(obj);

      // FIXME: Figure out how to import `vscode` package in server.ts without
      // getting runtime import errors to remove this deprecation warning.
      const contents = {
        value: obj.hover,
        kind: 'markdown',
      }

      if (obj.hover != '') {
        if (obj.span) {
          const lineBreaks = findLineBreaks(
            obj.file ? (await fs.promises.readFile(obj.file)).toString() : (document?.getText() ?? '')
          )

          return {
            contents,
            range: {
              start: convertSpan(obj.span.start, lineBreaks),
              end: convertSpan(obj.span.end, lineBreaks),
            },
          }
        } else {
          return { contents }
        }
      }
    }
  })
})

// This handler provides the initial list of the completion items.
connection.onCompletion(async (request: TextDocumentPositionParams): Promise<CompletionItem[]> => {
  return await durationLogWrapper(`onCompletion`, async () => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.

    const document = documents.get(request.textDocument.uri)
    const settings = await getDocumentSettings(request.textDocument.uri)

    const text = document?.getText()

    if (typeof text == 'string') {
      // connection.console.log("completion request: ");
      // connection.console.log(request.textDocument.uri);
      const index = convertPosition(request.position, text)
      // connection.console.log("index: " + index);
      const stdout = await runCompiler(text, '--ide-complete ' + index, settings, request.textDocument.uri)
      // connection.console.log("got: " + stdout);

      const lines = stdout.split('\n').filter((l) => l.length > 0)
      for (const line of lines) {
        const obj = JSON.parse(line)
        // connection.console.log("completions");
        // connection.console.log(obj);

        const output = []
        let index = 1
        for (const completion of obj.completions) {
          output.push({
            label: completion,
            kind: completion.includes('(') ? CompletionItemKind.Function : CompletionItemKind.Field,
            data: index,
          })
          index++
        }
        return output
      }
    }

    return []
  })
})

connection.onDefinition(async (request) => {
  return await durationLogWrapper(`onDefinition`, async (label) => {
    const document = documents.get(request.textDocument.uri)
    if (!document) return
    const settings = await getDocumentSettings(request.textDocument.uri)

    const text = document.getText()

    // connection.console.log(`[${label}] request: ${request.textDocument.uri}`);
    // connection.console.log("index: " + convertPosition(request.position, text));
    const stdout = await runCompiler(
      text,
      '--ide-goto-def ' + convertPosition(request.position, text),
      settings,
      request.textDocument.uri,
      { label: label }
    )
    return goToDefinition(document, stdout)
  })
})

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item
})

connection.languages.inlayHint.on((params: InlayHintParams) => {
  const document = documents.get(params.textDocument.uri) as NuTextDocument
  return document.nuInlayHints
})

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

// Listen on the connection
connection.listen()


