// ─── Worker protocol (renderer ↔ worker) ─────────────────────

export interface WorkerInitCommand {
  type: 'INIT';
}

export interface WorkerExecuteCommand {
  type: 'EXECUTE';
  payload: {
    code: string;
    timeoutMs?: number;
    requestId: string;
  };
}

export interface WorkerInstallPackageCommand {
  type: 'INSTALL_PACKAGE';
  payload: {
    packageName: string;
  };
}

export interface WorkerTerminateCommand {
  type: 'TERMINATE';
}

export interface WorkerGetStatusCommand {
  type: 'GET_STATUS';
}

export type WorkerCommand =
  | WorkerInitCommand
  | WorkerExecuteCommand
  | WorkerInstallPackageCommand
  | WorkerTerminateCommand
  | WorkerGetStatusCommand;

export type WorkerResponseType =
  | 'INITIALIZED'
  | 'OUTPUT'
  | 'RESULT'
  | 'ERROR'
  | 'STATUS'
  | 'PACKAGE_INSTALLED';

export interface WorkerInitializedResponse {
  type: 'INITIALIZED';
  payload: {
    pyodideVersion: string;
    availablePackages: number;
  };
}

export interface WorkerOutputResponse {
  type: 'OUTPUT';
  payload: {
    stream: 'stdout' | 'stderr';
    text: string;
    requestId: string;
  };
}

export interface WorkerResultResponse {
  type: 'RESULT';
  payload: {
    result: unknown;
    stdout: string[];
    stderr: string[];
    executionTimeMs: number;
    requestId: string;
  };
}

export interface WorkerErrorResponse {
  type: 'ERROR';
  payload: {
    message: string;
    stack?: string;
    requestId: string;
  };
}

export interface WorkerStatusResponse {
  type: 'STATUS';
  payload: {
    state: 'uninitialized' | 'initializing' | 'ready' | 'busy' | 'error' | 'terminated';
    pyodideVersion?: string;
    uptimeMs: number;
  };
}

export interface WorkerPackageInstalledResponse {
  type: 'PACKAGE_INSTALLED';
  payload: {
    packageName: string;
    version: string;
  };
}

export type WorkerResponse =
  | WorkerInitializedResponse
  | WorkerOutputResponse
  | WorkerResultResponse
  | WorkerErrorResponse
  | WorkerStatusResponse
  | WorkerPackageInstalledResponse;
