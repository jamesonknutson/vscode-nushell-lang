/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
  type CompletionItem,
  CompletionItemKind,
  type Definition,
  type Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  type HandlerResult,
  type Hover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type MarkupContent,
  ProposedFeatures,
  type TextDocumentIdentifier,
  type TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from 'vscode-languageserver/node';

import {
  InlayHint,
  InlayHintKind,
  InlayHintLabelPart,
  type InlayHintParams,
  type Position,
} from 'vscode-languageserver-protocol';

import { stdout } from 'node:process';
import { text } from 'node:stream/consumers';
import { TextEncoder } from 'node:util';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

interface NuTextDocument extends TextDocument {
  nuInlayHints?: InlayHint[];
}
import fs = require('fs');
import tmp = require('tmp');
import path = require('path');

import util = require('node:util');

import type { exec as _exec } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(
  require('node:child_process').exec as unknown as typeof _exec,
);

const definitions = new Map<string, Promise<CompletionItem['documentation']>>();

const tmpFile = tmp.fileSync({ prefix: 'nushell', keep: false });

const tmpFiles: import('tmp').FileResult[] = [tmpFile];

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

function includeFlagForPath(file_path: string): string {
  const parsed = URI.parse(file_path);
  if (parsed.scheme === 'file') {
    return `-I "${path.dirname(parsed.fsPath)}`;
  }
  return `-I "${file_path}`;
}

connection.onExit(() => {
  for (const tmpFile of tmpFiles) {
    tmpFile.removeCallback();
  }
});

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability =
    !!capabilities.textDocument?.publishDiagnostics?.relatedInformation;

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
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

let labelid = 0;
function createLabel(name: string): string {
  return `${name}#${labelid++}`;
}
async function durationLogWrapper<T>(
  name: string,
  fn: (label: string) => Promise<T>,
): Promise<T> {
  console.log(`Triggered ${name}: ...`);
  const label = createLabel(name);
  console.time(label);
  const result = await fn(label);

  // This purposefully has the same prefix length as the "Triggered " log above,
  // also does not add a newline at the end.
  process.stdout.write('Finished  ');
  console.timeEnd(label);
  return new Promise<T>((resolve) => resolve(result));
}

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The nushell settings
interface NushellIDESettings {
  hints: {
    showInferredTypes: boolean;
  };
  includeDirs: string[];
  maxNumberOfProblems: number;
  maxNushellInvocationTime: number;
  nushellExecutablePath: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: NushellIDESettings = {
  maxNumberOfProblems: 1000,
  hints: { showInferredTypes: true },
  nushellExecutablePath: 'nu',
  maxNushellInvocationTime: 10000000,
  includeDirs: [],
};
let globalSettings: NushellIDESettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<NushellIDESettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <NushellIDESettings>(
      (change.settings.nushellLanguageServer || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<NushellIDESettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'nushellLanguageServer',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

function debounce(func: any, wait: number, immediate: boolean) {
  let timeout: any;

  return function executedFunction(this: any, ...args: any[]) {
    const later = () => {
      timeout = null;
      if (!immediate) func.apply(this, args);
    };

    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(this, args);
  };
}

documents.onDidChangeContent(
  (() => {
    const throttledValidateTextDocument = debounce(
      validateTextDocument,
      500,
      false,
    );

    return (change) => {
      throttledValidateTextDocument(change.document);
    };
  })(),
);

async function validateTextDocument(
  textDocument: NuTextDocument,
): Promise<void> {
  return await durationLogWrapper(
    `validateTextDocument ${textDocument.uri}`,
    async (label) => {
      if (!hasDiagnosticRelatedInformationCapability) {
        console.error(
          'Trying to validate a document with no diagnostic capability',
        );
        return;
      }

      // In this simple example we get the settings for every validate run.
      const settings = await getDocumentSettings(textDocument.uri);

      // The validator creates diagnostics for all uppercase words length 2 and more
      const text = textDocument.getText();
      const lineBreaks = findLineBreaks(text);

      const stdout = await runCompiler(
        text,
        '--ide-check',
        settings,
        textDocument.uri,
        { label: label },
      );

      textDocument.nuInlayHints = [];
      const diagnostics: Diagnostic[] = [];

      // FIXME: We use this to deduplicate type hints given by the compiler.
      //        It'd be nicer if it didn't give duplicate hints in the first place.
      const seenTypeHintPositions = new Set();

      const lines = stdout
        .split(/[\r\n]+/gim)
        .map((s) => s.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        connection.console.log(`line: ${line}`);
        try {
          const obj = JSON.parse(line);

          if (obj.type === 'diagnostic') {
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
          } else if (obj.type === 'hint' && settings.hints.showInferredTypes) {
            if (!seenTypeHintPositions.has(obj.position)) {
              seenTypeHintPositions.add(obj.position);
              const position = convertSpan(obj.position.end, lineBreaks);
              const hint_string = `: ${obj.typename}`;
              const hint = InlayHint.create(
                position,
                [InlayHintLabelPart.create(hint_string)],
                InlayHintKind.Type,
              );

              textDocument.nuInlayHints.push(hint);
            }
          }
        } catch (e) {
          connection.console.error(`error: ${e}`);
        }
      }

      // Send the computed diagnostics to VSCode.
      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    },
  );
}

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log('We received an file change event');
});

function lowerBoundBinarySearch(arr: number[], num: number): number {
  let low = 0;
  let mid = 0;
  let high = arr.length - 1;

  if (num >= arr[high]) return high;

  while (low < high) {
    // Bitshift to avoid floating point division
    mid = (low + high) >> 1;

    if (arr[mid] < num) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low - 1;
}

function convertSpan(utf8_offset: number, lineBreaks: Array<number>): Position {
  const lineBreakIndex = lowerBoundBinarySearch(lineBreaks, utf8_offset);

  const start_of_line_offset =
    lineBreakIndex === -1 ? 0 : lineBreaks[lineBreakIndex] + 1;
  const character = Math.max(0, utf8_offset - start_of_line_offset);

  return { line: lineBreakIndex + 1, character };
}

function convertPosition(position: Position, text: string): number {
  let line = 0;
  let character = 0;
  const buffer = new TextEncoder().encode(text);

  let i = 0;
  while (i < buffer.length) {
    if (line === position.line && character === position.character) {
      return i;
    }

    if (buffer.at(i) === 0x0a) {
      line++;
      character = 0;
    } else {
      character++;
    }

    i++;
  }

  return i;
}

async function runCompiler(
  text: string, // this is the script or the snippet of nushell code
  flags: string,
  settings: NushellIDESettings,
  uri: string,
  options: { allowErrors?: boolean; label: string } = { label: 'runCompiler' },
  tmp: import('tmp').FileResult = tmpFile,
): Promise<string> {
  const allowErrors =
    options.allowErrors === undefined ? true : options.allowErrors;
  let usingFlags = flags;

  try {
    fs.writeFileSync(tmp.name, text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    connection.console.error(
      `[${options.label}] error writing to tmp file: ${e}`,
    );
  }

  let stdout = '';
  try {
    const script_path_flag = `${includeFlagForPath(uri)}\x1e${settings.includeDirs.join('\x1e')}"`;

    const max_errors = settings.maxNumberOfProblems;

    if (usingFlags.includes('ide-check')) {
      usingFlags = `${usingFlags} ${max_errors}`;
    }

    connection.console.log(
      `[${options.label}] running: ${settings.nushellExecutablePath} ${usingFlags} ${script_path_flag} ${tmp.name}`,
    );

    const output = await exec(
      `${settings.nushellExecutablePath} ${usingFlags} ${script_path_flag} ${tmp.name}`,
      {
        timeout: settings.maxNushellInvocationTime,
      },
    );
    stdout = output.stdout;
    console.log(`[${options.label}] stdout: ${stdout}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    stdout = e.stdout;
    connection.console.log(`[${options.label}] compile failed: ${e}`);
    if (!allowErrors) {
      throw e;
    }
  }

  return stdout;
}

connection.onHover(async (request: HoverParams) => {
  return await durationLogWrapper(`onHover`, async () => {
    const document = documents.get(request.textDocument.uri);
    const settings = await getDocumentSettings(request.textDocument.uri);

    const text = document?.getText();

    if (!(typeof text === 'string')) return null;

    // connection.console.log("request: ");
    // connection.console.log(request.textDocument.uri);
    // connection.console.log("index: " + convertPosition(request.position, text));
    const stdout = await runCompiler(
      text,
      `--ide-hover ${convertPosition(request.position, text)}`,
      settings,
      request.textDocument.uri,
    );

    const lines = stdout
      .split(/[\r\n]+/gim)
      .map((s) => s.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // connection.console.log("hovering");
        // connection.console.log(obj);

        // FIXME: Figure out how to import `vscode` package in server.ts without
        // getting runtime import errors to remove this deprecation warning.
        const contents: Hover['contents'] = {
          value: obj.hover,
          kind: 'markdown',
        };

        if (obj.hover !== '') {
          if (obj.span) {
            const lineBreaks = findLineBreaks(
              obj.file
                ? (await fs.promises.readFile(obj.file)).toString()
                : document?.getText() ?? '',
            );

            const newLocal: Hover = {
              contents,
              range: {
                start: convertSpan(obj.span.start, lineBreaks),
                end: convertSpan(obj.span.end, lineBreaks),
              },
            };

            return newLocal;
          }
          return { contents };
        }
      } catch (error) {
        connection.console.error(
          `Encountered error trying to parse hover info line ${line}, error: ${error}`,
        );
      }
    }
  });
});

const _definitions = (async () => {})();

async function experimental_getDefinitions() {
  const settings = globalSettings;

  const flags = [
    '--config g:/dotfiles/.config/nushell/config.nu',
    '--env-config g:/dotfiles/.config/nushell/env.nu',
    'g:/dotfiles/.config/nushell/scripts/scripts/defs.nu',
  ].join(' ');

  const output = await exec(`${settings.nushellExecutablePath} ${flags}`, {
    timeout: settings.maxNushellInvocationTime,
  });

  console.log(output);
}

async function getDefinition(
  text: string,
  textDocument: TextDocumentIdentifier,
): Promise<CompletionItem['documentation']> {
  let output = definitions.get(text);
  if (output) {
    return output;
  }

  output = (async (): Promise<CompletionItem['documentation']> => {
    try {
      const document = documents.get(textDocument.uri);
      const settings = await getDocumentSettings(textDocument.uri);
      const usingTmp = tmp.fileSync({ prefix: 'nushell', keep: false });
      tmpFiles.push(usingTmp);

      const stdout = await runCompiler(
        text,
        `--ide-hover ${convertPosition({ character: 0, line: 0 }, text)}`,
        settings,
        textDocument.uri,
        { label: 'getDefinition' },
        usingTmp,
      );

      const lines = stdout
        .split(/[\r\n]+/gim)
        .map((s) => s.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // connection.console.log("hovering");
          // connection.console.log(obj);
          // FIXME: Figure out how to import `vscode` package in server.ts without
          // getting runtime import errors to remove this deprecation warning.
          const contents: MarkupContent = {
            value: obj.hover,
            kind: 'markdown',
          };

          if (obj.hover !== '') {
            if (obj.span) {
              const lineBreaks = findLineBreaks(
                obj.file
                  ? (await fs.promises.readFile(obj.file)).toString()
                  : document?.getText() ?? '',
              );

              const newLocal = {
                contents,
                range: {
                  start: convertSpan(obj.span.start, lineBreaks),
                  end: convertSpan(obj.span.end, lineBreaks),
                },
              };

              return newLocal.contents;
            }
            return contents;
          }
        } catch (error) {
          connection.console.error(
            `Encountered error trying to parse hover info line ${line}, error: ${error}`,
          );
        }
      }
    } catch (error) {
      connection.console.error(
        `Encountered error trying to get definition, error: ${error}`,
      );
    }
  })()
    .then((output) => {
      connection.console.info(
        `Got def for text ${text}: ${JSON.stringify(output)}`,
      );
      return output;
    })
    .catch((error) => {
      connection.console.error(
        `Encountered error trying to get def for ${text}, ${error}`,
      );
      return undefined;
    });

  definitions.set(text, output);

  return output;
}

// biome-ignore lint/style/useConst: <explanation>
let executed = false;

// This handler provides the initial list of the completion items.
connection.onCompletion(
  async (request: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    return await durationLogWrapper(`onCompletion`, async () => {
      // The pass parameter contains the position of the text document in
      // which code complete got requested. For the example we ignore this
      // info and always provide the same completion items.
      if (!executed) {
        await experimental_getDefinitions();
        executed = true;
      }

      const document = documents.get(request.textDocument.uri);
      const settings = await getDocumentSettings(request.textDocument.uri);

      const text = document?.getText();
      const output: Promise<CompletionItem>[] = [];

      if (typeof text === 'string') {
        // connection.console.log("completion request: ");
        // connection.console.log(request.textDocument.uri);
        const index = convertPosition(request.position, text);
        // connection.console.log("index: " + index);
        const stdout = await runCompiler(
          text,
          `--ide-complete ${index}`,
          settings,
          request.textDocument.uri,
        );
        // connection.console.log("got: " + stdout);

        const lines = stdout
          .split(/[\r\n]+/gim)
          .map((s) => s.trim())
          .filter((l) => l.length > 0);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            // connection.console.log("completions");
            // connection.console.log(obj);

            let index = 1;
            for (const completion of obj.completions) {
              const completionItem = (async () => {
                const item: CompletionItem = {
                  label: completion,
                  kind: completion.includes('(')
                    ? CompletionItemKind.Function
                    : CompletionItemKind.Field,
                  data: index,
                  documentation: await getDefinition(
                    completion,
                    request.textDocument,
                  ),
                };

                return item;
              })();

              output.push(completionItem);

              index++;
            }
          } catch (error) {
            connection.console.error(
              `Encountered error trying to JSON.parse onCompletion line ${line}: ${error}`,
            );
          }
        }
      }

      const waited = await Promise.all(output);

      const mappings = await Promise.all(definitions.values()).then((x) =>
        x.filter((x) => x !== undefined),
      );

      const final = await Promise.all(
        waited.map(async (item) => {
          const found = mappings.find((mapping) => {
            if (typeof mapping === 'string') {
              return;
            }
          });
        }),
      );

      return waited;
    });
  },
);

connection.onDefinition(async (request) => {
  return await durationLogWrapper(`onDefinition`, async (label) => {
    const document = documents.get(request.textDocument.uri);
    if (!document) return;
    const settings = await getDocumentSettings(request.textDocument.uri);

    const text = document.getText();

    // connection.console.log(`[${label}] request: ${request.textDocument.uri}`);
    // connection.console.log("index: " + convertPosition(request.position, text));
    const stdout = await runCompiler(
      text,
      `--ide-goto-def ${convertPosition(request.position, text)}`,
      settings,
      request.textDocument.uri,
      { label: label },
    );
    return goToDefinition(document, stdout);
  });
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item;
});

async function goToDefinition(
  document: TextDocument,
  nushellOutput: string,
): Promise<HandlerResult<Definition, void> | undefined> {
  const lines = nushellOutput
    .split(/[\r\n]+/gim)
    .map((s) => s.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // connection.console.log("going to type definition");
      // connection.console.log(obj);
      if (obj.file === '' || obj.file === '__prelude__') return;

      let documentText: string;
      if (obj.file) {
        if (fs.existsSync(obj.file)) {
          documentText = await fs.promises
            .readFile(obj.file)
            .then((b) => b.toString());
        } else {
          connection.console.log(`File ${obj.file} does not exist`);
          return;
        }
      } else {
        documentText = document.getText();
      }

      const lineBreaks: number[] = findLineBreaks(documentText);

      let uri = '';
      if (obj.file === tmpFile.name) {
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
    } catch (error) {
      connection.console.error(
        `Encountered error trying to JSON.parse gotoDefinition line ${line}: ${error}`,
      );
    }
  }
}

connection.languages.inlayHint.on((params: InlayHintParams) => {
  const document = documents.get(params.textDocument.uri) as NuTextDocument;
  return document.nuInlayHints;
});

function findLineBreaks(utf16_text: string): Array<number> {
  const utf8_text = new TextEncoder().encode(utf16_text);
  const lineBreaks: Array<number> = [];

  for (let i = 0; i < utf8_text.length; ++i) {
    if (utf8_text[i] === 0x0a) {
      lineBreaks.push(i);
    }
  }

  return lineBreaks;
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

class CustomDefinitions {
  private _definitions = new Map<
    string,
    Promise<CompletionItem['documentation']>
  >();
}

async function getDefaultScope({
  includeDirs,
  maxNushellInvocationTime,
  nushellExecutablePath: binary,
}: NushellIDESettings) {
  const args = [
    binary,
    `--no-newline`,
    `--stdin`,
    `--include-path=${includeDirs.join('\x1e')}`,
    `--commands='scope commands | to json -r | save ${tmpFile.name} --force'`,
  ];

  const { stdout, stderr } = await exec(args.join(' '), {
    windowsHide: true,
    timeout: maxNushellInvocationTime,
  });

  return { stdout, stderr };
}
