// setup 모듈의 공개 진입점 (architecture.md 3.13). 조립(entry/cli)만 가져다 쓴다.

export { runCli, parseCliArgs, USAGE } from './cli.js';
export type { CliCommand, CliDeps } from './cli.js';
export { chooseNodePath, readInstallerEnv, registeredNodePath, transientNodeRoots } from './installer-env.js';
export type { EnvMap, InstallerEnv, NodePathChoice } from './installer-env.js';
export { launchMcpProcess } from './mcp-process.js';
export type { LaunchMcp, McpLaunchSpec, McpProcess } from './mcp-process.js';
export { EXIT_FAILED, EXIT_NO_HOST, EXIT_OK, runRemove, runSetup } from './setup.js';
export type { SetupDeps } from './setup.js';
export { runDoctor } from './doctor.js';
export type { DoctorDeps, DoctorLimits, DoctorResult } from './doctor.js';
