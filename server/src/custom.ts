import fs = require('fs');
import type { FileResult } from 'tmp';
import { type NushellIDESettings, execFile } from './shared';

export interface NuPathsJSON {
  'default-config-dir': string;
  'config-path': string;
  'env-path': string;
  'history-path': string;
  'loginshell-path': string;
  'plugin-path': string;
  'home-path': string;
  'data-dir': string;
  'cache-dir': string;
  'vendor-autoload-dirs': string[];
  'temp-path': string;
  pid: number;
  'os-info': OSInfo;
  'startup-time': number;
  'is-interactive': boolean;
  'is-login': boolean;
  'history-enabled': boolean;
  'current-exe': string;
}

export interface OSInfo {
  name: string;
  arch: string;
  family: string;
  kernel_version: string;
}

export async function tryParseJSON<T = any>(
  stdout: string,
  tmpFile: FileResult,
): Promise<T> {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(fs.readFileSync(tmpFile.name, { encoding: 'utf8' }));
  }
}

export async function getNuPaths(
  settings: NushellIDESettings,
  tmpFile: FileResult,
): Promise<NuPathsJSON> {
  const { stdout } = await execFile(settings.nushellExecutablePath, [
    '--no-newline',
    '--commands',
    `$nu | to json -r | tee { save ${tmpFile.name} --force }`,
  ]);

  return tryParseJSON<NuPathsJSON>(stdout, tmpFile);
}

export async function getNuCommands(
  settings: NushellIDESettings,
  tmpFile: FileResult,
  paths?: NuPathsJSON,
) {
  const usingPaths = paths ?? (await getNuPaths(settings, tmpFile));
  const configPath = usingPaths['config-path'];
  const envPath = usingPaths['env-path'];
  const pluginPath = usingPaths['plugin-path'];
  const { stdout } = await execFile(settings.nushellExecutablePath, [
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
  ]);
}
