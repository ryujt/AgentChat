// diagnostics 의 공개 진입점 (architecture.md 3.12). 로거를 만드는 곳은 조립뿐이다.
// 실제 파일·stderr·stdout 은 이 파일에서만 닿는다. 로거 본체는 그것을 인자로 받는다.

import { accessSync, constants, mkdirSync } from 'node:fs';
import { appendFile, readdir, rm, stat } from 'node:fs/promises';
import type { CreateFileLogger, CreateStdoutLogger } from './contract.js';
import { createFileLoggerWith } from './file-logger.js';
import type { FileLoggerIo, StderrSink } from './file-logger.js';
import { createStdoutLoggerWith } from './stdout-logger.js';
import type { LineSink } from './stdout-logger.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const ignoreStreamError = (): void => undefined;

const nodeIo: FileLoggerIo = {
  prepareDir(dir) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    accessSync(dir, constants.W_OK | constants.X_OK);
  },
  append: (path, text) => appendFile(path, text, { encoding: 'utf8', mode: FILE_MODE, flag: 'a' }),
  list: (dir) => readdir(dir),
  size: async (path) => {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  },
  remove: (path) => rm(path, { force: true }),
};

const nodeStderr: StderrSink = {
  write(text) {
    process.stderr.write(text);
  },
  guard() {
    process.stderr.on('error', ignoreStreamError);
    return () => {
      process.stderr.off('error', ignoreStreamError);
    };
  },
};

const guardStdout = (): (() => void) => {
  process.stdout.on('error', ignoreStreamError);
  return () => {
    process.stdout.off('error', ignoreStreamError);
  };
};

const nodeStdout: LineSink = {
  writeLine(line) {
    process.stdout.write(`${line}\n`);
  },
  guard: guardStdout,
};

/** Lambda 는 console.log 로 낸다. 런타임이 CloudWatch Logs 로 옮긴다(architecture.md 6.3). */
const lambdaConsole: LineSink = {
  writeLine(line) {
    console.log(line);
  },
  guard: guardStdout,
};

export const createFileLogger: CreateFileLogger = (options) => createFileLoggerWith(options, { io: nodeIo, stderr: nodeStderr });

export const createStdoutLogger: CreateStdoutLogger = (options) =>
  createStdoutLoggerWith(options, options.service === 'lambda' ? lambdaConsole : nodeStdout);
