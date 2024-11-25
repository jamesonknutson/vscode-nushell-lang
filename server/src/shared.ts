import util = require('node:util');
import type { exec as _exec, execFile as _execFile } from 'node:child_process';

// The nushell settings
export interface NushellIDESettings {
  hints: {
    showInferredTypes: boolean;
  };
  includeDirs: string[];
  maxNumberOfProblems: number;
  maxNushellInvocationTime: number;
  nushellExecutablePath: string;
}

export const execFile = util.promisify(
  require('node:child_process').execFile as unknown as typeof _execFile,
);
export const exec = util.promisify(
  require('node:child_process').exec as unknown as typeof _exec,
);
