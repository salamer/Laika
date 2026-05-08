import { resolve, normalize, sep, isAbsolute } from 'node:path';

/**
 * Resolve user paths inside a single workspace root and reject traversal / absolute paths.
 */
export class PathValidator {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(normalize(workspaceRoot));
  }

  validate(userPath: string): string {
    const normalized = normalize(userPath).replace(/^[/\\]+/, '');

    if (!normalized || normalized === '.') {
      return this.workspaceRoot;
    }

    if (isAbsolute(userPath) || userPath.includes(':')) {
      throw new PathValidationError(
        'Absolute paths are not allowed. Use paths relative to the workspace (virtual root).'
      );
    }

    const absolutePath = resolve(this.workspaceRoot, normalized);

    const root = this.workspaceRoot;
    const isRoot = absolutePath === root;
    const underRoot = absolutePath.startsWith(root + sep);
    if (!isRoot && !underRoot) {
      throw new PathValidationError(
        `Path traversal detected. "${userPath}" resolves outside the workspace.`
      );
    }

    return absolutePath;
  }

  toVirtualPath(absolutePath: string): string {
    const root = this.workspaceRoot;
    if (absolutePath === root) return '/';
    const prefix = root + sep;
    if (!absolutePath.startsWith(prefix)) {
      throw new PathValidationError('Path is outside workspace.');
    }
    const rel = absolutePath.slice(prefix.length);
    return rel.split(sep).join('/');
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}
