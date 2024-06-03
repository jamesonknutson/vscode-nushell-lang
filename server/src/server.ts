/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
  CompletionItem,
  CompletionItemKind,
  Definition,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  HandlerResult,
  HoverParams,
  InitializeParams,
  InitializeResult,
  MarkupContent,
  MarkupKind,
  ProposedFeatures,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from 'vscode-languageserver/node'

import { InlayHint, InlayHintKind, InlayHintLabelPart, InlayHintParams, Position } from 'vscode-languageserver-protocol'

import execa from 'execa'
import { TextEncoder } from 'node:util'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'

interface NuTextDocument extends TextDocument {
  nuInlayHints?: InlayHint[]
}
import fs = require('fs')
import tmp = require('tmp')
import path = require('path')

import util = require('node:util')

// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(require('node:child_process').exec)

const tmpFile = tmp.fileSync({ prefix: 'nushell', keep: false })
const RECORD_SEP = '\u{1E}'

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all)

type Console = {
  [K in keyof typeof connection.console as (typeof connection.console)[K] extends (message: string) => any
    ? K
    : never]: (typeof connection.console)[K] extends (...args: infer Args) => infer Output
    ? (...args: [...Args, ...rest: any[]]) => Output
    : never
}

const writeToConsole = <K extends keyof Console>(key: K, ...args: Parameters<Console[K]>): void => {
  // Local log
  console[key](...args)

  const [ msg, ...rest ] = args
  // External log, emulating console.log behaviour
  connection.console[key](util.format(msg, ...rest))
}

const _console: Console = {
  error: (message: string, ...rest: any[]) => writeToConsole('error', message, ...rest),
  warn: (message: string, ...rest: any[]) => writeToConsole('warn', message, ...rest),
  info: (message: string, ...rest: any[]) => writeToConsole('info', message, ...rest),
  log: (message: string, ...rest: any[]) => writeToConsole('log', message, ...rest),
  debug: (message: string, ...rest: any[]) => writeToConsole('debug', message, ...rest),
}

// Create a simple text document manager.
const documents = new TextDocuments<TextDocument>(TextDocument)

let hasConfigurationCapability = false
let hasWorkspaceFolderCapability = false
let hasDiagnosticRelatedInformationCapability = false

function includeFlagForPath(file_path: string): string {
  const parsed = URI.parse(file_path)
  if (parsed.scheme === 'file') {
    return '-I ' + '"' + path.dirname(parsed.fsPath)
  }
  return '-I ' + '"' + file_path
}

connection.onExit(() => {
  tmpFile.removeCallback()
})

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration)
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders)
  hasDiagnosticRelatedInformationCapability = !!capabilities.textDocument?.publishDiagnostics?.relatedInformation

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

let labelid = 0
function createLabel(name: string): string {
  return `${name}#${labelid++}`
}
async function durationLogWrapper<T>(name: string, fn: (label: string) => Promise<T>): Promise<T> {
  _console.log('Triggered ' + name + ': ...')
  const label = createLabel(name)
  console.time(label)
  const result = await fn(label)

  // This purposefully has the same prefix length as the "Triggered " log above,
  // also does not add a newline at the end.
  process.stdout.write('Finished  ')
  console.timeEnd(label)
  return new Promise<T>(resolve => resolve(result))
}

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined)
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      _console.log('Workspace folder change event received.')
    })
  }
})

// The nushell settings
interface NushellIDESettings {
  maxNumberOfProblems: number
  hints: {
    showInferredTypes: boolean
  }
  nushellExecutablePath: string
  maxNushellInvocationTime: number
  includeDirs: string[]
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: NushellIDESettings = {
  maxNumberOfProblems: 1000,
  hints: { showInferredTypes: true },
  nushellExecutablePath: 'nu',
  maxNushellInvocationTime: 10_000_000,
  includeDirs: [],
}
let globalSettings: NushellIDESettings = defaultSettings

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<NushellIDESettings>>()

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear()
  } else {
    globalSettings = (change.settings.nushellLanguageServer || defaultSettings) as NushellIDESettings
  }

  // Revalidate all open text documents
  for (const item of documents.all()) {
    validateTextDocument(item)
  }
})

function getDocumentSettings(resource: string): Thenable<NushellIDESettings> {
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

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri)
})

function debounce(func: any, wait: number, immediate: boolean) {
  let timeout: any

  return function executedFunction(this: any, ...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const context = this

    const later = function () {
      timeout = null
      if (!immediate) func.apply(context, args)
    }

    const callNow = immediate && !timeout
    clearTimeout(timeout)
    timeout = setTimeout(later, wait)
    if (callNow) func.apply(context, args)
  }
}

documents.onDidChangeContent(
  (() => {
    const throttledValidateTextDocument = debounce(validateTextDocument, 500, false)

    return change => {
      throttledValidateTextDocument(change.document)
    }
  })(),
)

async function validateTextDocument(textDocument: NuTextDocument): Promise<void> {
  return await durationLogWrapper(`validateTextDocument ${textDocument.uri}`, async label => {
    if (!hasDiagnosticRelatedInformationCapability) {
      _console.error('Trying to validate a document with no diagnostic capability')
      return
    }

    // In this simple example we get the settings for every validate run.
    const settings = await getDocumentSettings(textDocument.uri)

    // The validator creates diagnostics for all uppercase words length 2 and more
    const text = textDocument.getText()
    const lineBreaks = findLineBreaks(text)

    /* const stdout = await runCompiler(
				text,
				'--ide-check',
				settings,
				textDocument.uri,
				{ label: label },
			); */

    const stdout = await knutCompiler({
      label,
      settings,
      mode: 'ide-check',
      text,
      uri: textDocument.uri,
    })

    textDocument.nuInlayHints = []
    const diagnostics: Diagnostic[] = []

    // FIXME: We use this to deduplicate type hints given by the compiler.
    //        It'd be nicer if it didn't give duplicate hints in the first place.
    const seenTypeHintPositions = new Set()

    const lines = stdout.split('\n').filter(l => l.length > 0)
    for (const line of lines) {
      _console.log('line: ' + line)
      try {
        const obj = JSON.parse(line)

        if (obj.type == 'diagnostic') {
          let severity: DiagnosticSeverity = DiagnosticSeverity.Error

          switch (obj.severity) {
            case 'Information': {
              severity = DiagnosticSeverity.Information
              break
            }
            case 'Hint': {
              severity = DiagnosticSeverity.Hint
              break
            }
            case 'Warning': {
              severity = DiagnosticSeverity.Warning
              break
            }
            case 'Error': {
              severity = DiagnosticSeverity.Error
              break
            }
          }

          const position_start = convertSpan(obj.span.start, lineBreaks)
          const position_end = convertSpan(obj.span.end, lineBreaks)

          const diagnostic: Diagnostic = {
            severity,
            range: {
              start: position_start,
              end: position_end,
            },
            message: obj.message,
            source: textDocument.uri,
          }

          // _console.log(diagnostic.message);

          diagnostics.push(diagnostic)
        } else if (obj.type == 'hint' && settings.hints.showInferredTypes) {
          if (!seenTypeHintPositions.has(obj.position)) {
            seenTypeHintPositions.add(obj.position)
            const position = convertSpan(obj.position.end, lineBreaks)
            const hint_string = ': ' + obj.typename
            const hint = InlayHint.create(position, [ InlayHintLabelPart.create(hint_string) ], InlayHintKind.Type)

            textDocument.nuInlayHints.push(hint)
          }
        }
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        _console.error(`error: `, error)
      }
    }

    // Send the computed diagnostics to VSCode.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
  })
}

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VSCode
  _console.log('We received an file change event')
})

function lowerBoundBinarySearch(arr: number[], num: number): number {
  let low = 0
  let mid = 0
  let high = arr.length - 1

  if (num >= arr[high]) return high

  while (low < high) {
    // Bitshift to avoid floating point division
    mid = (low + high) >> 1

    if (arr[mid] < num) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low - 1
}

function convertSpan(utf8_offset: number, lineBreaks: Array<number>): Position {
  const lineBreakIndex = lowerBoundBinarySearch(lineBreaks, utf8_offset)

  const start_of_line_offset = lineBreakIndex == -1 ? 0 : lineBreaks[lineBreakIndex] + 1
  const character = Math.max(0, utf8_offset - start_of_line_offset)

  return { line: lineBreakIndex + 1, character }
}

function convertPosition(position: Position, text: string): number {
  let line = 0
  let character = 0
  const buffer = new TextEncoder().encode(text)

  let i = 0
  while (i < buffer.length) {
    if (line == position.line && character == position.character) {
      return i
    }

    if (buffer.at(i) == 0x0A) {
      line++
      character = 0
    } else {
      character++
    }

    i++
  }

  return i
}

interface KnutCompileOptions {
  allowErrors?: boolean
  settings: NushellIDESettings
  label?: string
  uri: string
  text: string
  mode: 'ide-complete' | 'ide-hover' | 'ide-check' | 'ide-goto-def'
  offset?: number
}

function getFileSystemPathFor(input: string | URI) {
  return path.normalize(
    typeof input === 'string'
      ? input.startsWith('file:')
        ? URI.parse(input).fsPath
        : URI.file(input).fsPath
      : input.fsPath,
  )
}

function getFsPathKey(input: string) {
  return path
    .normalize(input)
    .toLowerCase()
    .replaceAll(/[/\\]+/g, '/')
}

const lookups = new Map<string, Promise<string>>()
function getDirFor(input: string | URI): Promise<string> {
  const usePath = getFileSystemPathFor(input)
  const cacheKey = getFsPathKey(usePath)
  _console.log(`normalizedPath from ${input.toString()} (is URI: ${input instanceof URI}): ${usePath}`)
  const cached = lookups.get(cacheKey)
  if (cached) {
    return cached
  }

  lookups.set(
    cacheKey,
    (async () => {
      try {
        const stats = await fs.promises.stat(usePath)
        if (stats.isDirectory()) {
          return usePath
        } else if (stats.isFile()) {
          return await getDirFor(path.dirname(usePath))
        } else {
          _console.error(`Invalid type for '${usePath}', not directory or file.`)
          return ''
        }
      } catch (error) {
        console.error()
        _console.error(`Encountered error looking up path for '${usePath}':`, error)
        return ''
      }
    })(),
  )

  return lookups.get(cacheKey)!
}

async function getIncludeDirsFor(uri: string, settings: NushellIDESettings) {
  return [ ...new Set(await Promise.all([ uri, ...settings.includeDirs ].map(getDirFor))) ].filter(s => s.length > 0)
}

async function knutCompiler({
  label = 'knutCompiler',
  mode,
  settings,
  text,
  uri,
  allowErrors,
  offset,
}: KnutCompileOptions) {
  const _allowErrors = allowErrors ?? true

  try {
    fs.writeFileSync(tmpFile.name, text)
  } catch (error: any) {
    _console.error(`[${label}] error writing to tmp file: ${error}`)
  }

  let stdout = ''
  try {
    const includeDirs = await getIncludeDirsFor(uri, settings)
    /* if (includeDirs.length === 1) {
			includeDirs.push('');
		} */

    const jointDirs = includeDirs.join(RECORD_SEP)
    const execaArgs: string[] = [ `--${mode}` ]

    if (typeof offset === 'number') {
      execaArgs.push(offset.toString())
    } else if (mode === 'ide-check') {
      execaArgs.push(settings.maxNumberOfProblems.toString())
    }

    if (includeDirs.length > 0) {
      execaArgs.push(`--include-path`, jointDirs)
    }

    execaArgs.push(tmpFile.name)

    _console.log(`[${label}] running: ${settings.nushellExecutablePath} ${execaArgs.join(' ')}`)

    const result = await execa(settings.nushellExecutablePath, execaArgs, {
      timeout: settings.maxNushellInvocationTime,
    })

    _console.log(`[${label}] used command: ${result.escapedCommand}`)
    _console.log(`[${label}] stdout: ${result.stdout}`)
    return result.stdout
  } catch (error: any) {
    stdout = error.stdout
    _console.log(`[${label}] compile failed: ` + error)
    if (!_allowErrors) {
      throw error
    }
  }

  return stdout
}

connection.onHover(async (request: HoverParams) => {
  return await durationLogWrapper(`onHover`, async () => {
    const document = documents.get(request.textDocument.uri)
    const settings = await getDocumentSettings(request.textDocument.uri)

    const text = document?.getText()

    if (!(typeof text == 'string')) return null

    // _console.log("request: ");
    // _console.log(request.textDocument.uri);
    // _console.log("index: " + convertPosition(request.position, text));
    /* const stdout = await runCompiler(
			text,
			'--ide-hover ' + convertPosition(request.position, text),
			settings,
			request.textDocument.uri,
		); */

    const stdout = await knutCompiler({
      settings,
      mode: 'ide-hover',
      offset: convertPosition(request.position, text),
      text,
      uri: request.textDocument.uri,
    })

    const lines = stdout.split('\n').filter(l => l.length > 0)
    for (const line of lines) {
      const obj = JSON.parse(line)
      // _console.log("hovering");
      // _console.log(obj);

      // FIXME: Figure out how to import `vscode` package in server.ts without
      // getting runtime import errors to remove this deprecation warning.
      const contents: MarkupContent = {
        value: obj.hover,
        kind: MarkupKind.Markdown,
      }

      if (obj.hover != '') {
        if (obj.span) {
          let inputText = ''
          if (typeof obj === 'object' && obj !== null && 'file' in obj && typeof obj.file === 'string') {
            const fileText = await fs.promises.readFile(obj.file)
            inputText = fileText.toString()
          } else {
            inputText = document?.getText() ?? ''
          }

          const lineBreaks = findLineBreaks(inputText)

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

    // return null
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
      // _console.log("completion request: ");
      // _console.log(request.textDocument.uri);
      const index = convertPosition(request.position, text)
      // _console.log("index: " + index);
      /* const stdout = await runCompiler(
					text,
					'--ide-complete ' + index,
					settings,
					request.textDocument.uri,
				); */
      const stdout = await knutCompiler({
        text,
        mode: 'ide-complete',
        offset: index,
        settings,
        uri: request.textDocument.uri,
      })
      // _console.log("got: " + stdout);

      const stdoutLines = stdout.split(/\r?\n/gm).map(l => l.trim())
      const lines = stdoutLines.filter(l => l.length > 0)

      _console.log(
        `Trying to extract JSON from ${stdoutLines.length} stdout lines (filtered to ${lines.length} with text)`,
        lines,
      )
      for (const line of lines) {
        const fixedLine = line.replaceAll(/\\+/g, '/')
        try {
          const obj = JSON.parse(fixedLine)

          // _console.log("completions");
          // _console.log(obj);

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
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          _console.error(`error decoding json from ${fixedLine}: ${error}`)
        }
      }
    }

    return []
  })
})

connection.onDefinition(async request => {
  return await durationLogWrapper(`onDefinition`, async label => {
    const document = documents.get(request.textDocument.uri)
    if (!document) return
    const settings = await getDocumentSettings(request.textDocument.uri)

    const text = document.getText()

    // _console.log(`[${label}] request: ${request.textDocument.uri}`);
    // _console.log("index: " + convertPosition(request.position, text));
    /* const stdout = await runCompiler(
			text,
			'--ide-goto-def ' + convertPosition(request.position, text),
			settings,
			request.textDocument.uri,
			{ label: label },
		); */
    const stdout = await knutCompiler({
      text,
      settings,
      uri: request.textDocument.uri,
      label,
      mode: 'ide-goto-def',
      offset: convertPosition(request.position, text),
    })
    return goToDefinition(document, stdout)
  })
})

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item
})

async function goToDefinition(
  document: TextDocument,
  nushellOutput: string,
): Promise<HandlerResult<Definition, void> | undefined> {
  const lines = nushellOutput.split('\n').filter(l => l.length > 0)
  for (const line of lines) {
    const obj = JSON.parse(line)
    // _console.log("going to type definition");
    // _console.log(obj);
    if (obj.file === '' || obj.file === '__prelude__') return

    let documentText: string
    if (obj.file) {
      if (fs.existsSync(obj.file)) {
        documentText = await fs.promises.readFile(obj.file).then(b => b.toString())
      } else {
        _console.log(`File ${obj.file} does not exist`)
        return
      }
    } else {
      documentText = document.getText()
    }

    const lineBreaks: number[] = findLineBreaks(documentText)

    let uri = ''
    if (obj.file == tmpFile.name) {
      uri = document.uri
    } else {
      uri = obj.file ? URI.file(obj.file).toString() : document.uri
    }

    // _console.log(uri);

    return {
      uri: uri,
      range: {
        start: convertSpan(obj.start, lineBreaks),
        end: convertSpan(obj.end, lineBreaks),
      },
    }
  }
}

connection.languages.inlayHint.on((params: InlayHintParams) => {
  const document = documents.get(params.textDocument.uri) as NuTextDocument
  return document.nuInlayHints
})

function findLineBreaks(utf16_text: string): Array<number> {
  const utf8_text = new TextEncoder().encode(utf16_text)
  const lineBreaks: Array<number> = []

  for (let i = 0; i < utf8_text.length; ++i) {
    if (utf8_text[i] == 0x0A) {
      lineBreaks.push(i)
    }
  }

  return lineBreaks
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

// Listen on the connection
connection.listen()
