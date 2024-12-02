import fs = require('node:fs')
import { oneLine, stripIndents } from 'common-tags'
import type { FileResult } from 'tmp'
import type { JsonValue } from 'type-fest'
import { type NushellIDESettings, execFile } from './shared'

import { type CompletionItem, CompletionItemKind } from 'vscode-languageserver/node'

import { MarkupKind } from 'vscode-languageserver-protocol'

export interface NuPathsJSON {
  'default-config-dir': string
  'config-path': string
  'env-path': string
  'history-path': string
  'loginshell-path': string
  'plugin-path': string
  'home-path': string
  'data-dir': string
  'cache-dir': string
  'vendor-autoload-dirs': string[]
  'temp-path': string
  pid: number
  'os-info': OSInfo
  'startup-time': number
  'is-interactive': boolean
  'is-login': boolean
  'history-enabled': boolean
  'current-exe': string
}

export interface OSInfo {
  name: string
  arch: string
  family: string
  kernel_version: string
}

export interface NuCommandJSON {
  name: string
  category: string
  signatures: { [key: string]: Signature[] }
  description: string
  examples: Example[]
  type: Type
  is_sub: boolean
  is_const: boolean
  creates_scope: boolean
  extra_description: string
  search_terms: string
  decl_id: number
}

export interface Example {
  description: string
  example: string
  result: JsonValue
}

export interface Signature {
  parameter_name: null | string
  parameter_type: ParameterType
  syntax_shape: null | string
  is_optional: boolean
  short_flag: null | string
  description: null | string
  custom_completion: string | null
  parameter_default: JsonValue
}

export enum ParameterType {
  Input = 'input',
  Named = 'named',
  Output = 'output',
  Positional = 'positional',
  REST = 'rest',
  Switch = 'switch',
}

export enum Type {
  BuiltIn = 'built-in',
  Custom = 'custom',
  External = 'external',
  Keyword = 'keyword',
  Plugin = 'plugin',
}

export async function tryParseJSON<T = any>(stdout: string, tmpFile: FileResult): Promise<T> {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    return JSON.parse(fs.readFileSync(tmpFile.name, { encoding: 'utf8' }))
  }
}

export async function getNuPaths(settings: NushellIDESettings, tmpFile: FileResult): Promise<NuPathsJSON> {
  const { stdout } = await execFile(
    settings.nushellExecutablePath,
    ['--no-newline', '--commands', `$nu | to json -r | tee { save ${tmpFile.name} --force }`],
    {
      maxBuffer: Number.MAX_SAFE_INTEGER,
      timeout: settings.maxNushellInvocationTime,
    }
  )

  return tryParseJSON<NuPathsJSON>(stdout, tmpFile)
}

export async function getNuCommands(
  settings: NushellIDESettings,
  tmpFile: FileResult,
  paths?: NuPathsJSON
): Promise<NuCommandJSON[]> {
  const usingPaths = paths ?? (await getNuPaths(settings, tmpFile))
  const configPath = usingPaths['config-path']
  const envPath = usingPaths['env-path']
  const pluginPath = usingPaths['plugin-path']
  const { stdout } = await execFile(
    settings.nushellExecutablePath,
    [
      '--no-newline',
      '--config',
      configPath,
      '--env-config',
      envPath,
      '--plugin-config',
      pluginPath,
      '--include-path',
      settings.includeDirs.join('\x1e'),
      '--commands',
      `scope commands | to json -r | tee { save ${tmpFile.name} --force }`,
    ],
    {
      maxBuffer: Number.MAX_SAFE_INTEGER,
      timeout: settings.maxNushellInvocationTime,
    }
  )

  return tryParseJSON<NuCommandJSON[]>(stdout, tmpFile)
}

export function getCompletion(command: NuCommandJSON) {
  const usage_param_strings: string[] = []
  const param_strings: string[] = []
  const flag_strings: string[] = []
  const input_output: string[] = []
  const io_types = Object.entries(command.signatures).map(([input_type, signature]) => ({ input_type, signature }))

  for (const sig of io_types[0].signature) {
    const parameter_name = sig.parameter_name || 'arg'

    switch (sig.parameter_type) {
      case ParameterType.Input:
      case ParameterType.Output:
        break
      case ParameterType.REST: {
        usage_param_strings.push(`<...${parameter_name}>`)
        param_strings.push(oneLine`
          ...${parameter_name}${sig.syntax_shape !== null ? `: ${sig.syntax_shape}${sig.custom_completion ? `@"${sig.custom_completion}"` : ''}` : ''}${sig.description ? ` - ${sig.description}` : ''}
        `)
        break
      }
      case ParameterType.Positional: {
        usage_param_strings.push(`<${parameter_name}${sig.is_optional ? '?' : ''}>`)
        param_strings.push(oneLine`
          ${parameter_name}${sig.syntax_shape !== null ? `: ${sig.syntax_shape}${sig.custom_completion ? `@"${sig.custom_completion}"` : ''}` : ''}${
            sig.parameter_default ? ` = ${JSON.stringify(sig.parameter_default, null, 2)}` : ''
          }${sig.description ? ` - ${sig.description}` : ''}
        `)
        break
      }
      case ParameterType.Named: {
        flag_strings.push(oneLine`
          ${sig.short_flag ? `\`-${sig.short_flag}\`, ` : ''}\`--${parameter_name}\`${
            sig.syntax_shape !== null
              ? ` <${sig.syntax_shape}${sig.custom_completion ? `@"${sig.custom_completion}"` : ''}>`
              : ''
          }${sig.parameter_default ? ` = ${JSON.stringify(sig.parameter_default, null, 2)}` : ''}${
            sig.description ? ` - ${sig.description}` : ''
          }
        `)
        break
      }
      case ParameterType.Switch: {
        flag_strings.push(oneLine`
          ${sig.short_flag ? `\`-${sig.short_flag}\`, ` : ''}\`--${parameter_name}\`${sig.description ? ` - ${sig.description}` : ''}
        `)
        break
      }
    }
  }

  for (const io of Object.values(command.signatures)) {
    const input = io.find((x) => x.parameter_type === ParameterType.Input)
    const output = io.find((x) => x.parameter_type === ParameterType.Output)
    input_output.push(oneLine`
      ${input?.syntax_shape} | ${output?.syntax_shape}
    `)
  }

  const mdString = stripIndents`
    ${command.description}${command.extra_description.length ? `\n${command.extra_description}` : ''}

    # Usage
    \`\`\`nushell
      ${command.name} {flags} ${usage_param_strings.join(' ')}
    \`\`\`

    # Flags
    ${flag_strings.join('\n')}
    \`-h\`, \`--help\` - Display the help message for this command

    # Parameters
    ${param_strings.join('\n')}

    # Input/Output Types
    ${input_output.join('\n')}
  `

  const output = {
    label: command.name,
    kind: CompletionItemKind.Function,
    documentation: {
      kind: MarkupKind.Markdown,
      value: mdString,
    },
  } satisfies CompletionItem

  return output
}

let _completions: Map<string, ReturnType<typeof getCompletion>> | undefined = undefined

export async function getCustomCompletions(settings: NushellIDESettings, tmpFile: FileResult) {
  if (_completions) {
    return _completions
  }

  const paths = await getNuPaths(settings, tmpFile)
  const commands = await getNuCommands(settings, tmpFile, paths)
  _completions = new Map(commands.map((command) => [command.name, getCompletion(command)]))

  return _completions
}
