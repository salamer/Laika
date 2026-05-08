import { resolve, normalize, sep, relative, isAbsolute } from 'node:path';

/**
 * Resolve user paths inside a single workspace root and reject traversal / absolute paths.
 * Uses `path.relative` so containment works on Windows (drive letters, case differences).
 */
export class PathValidator {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(normalize(workspaceRoot));
  }

  /** True if `target` is the workspace root or a path strictly inside it (same volume). */
  private containsResolvedTarget(targetAbs: string): boolean {
    const root = this.workspaceRoot;
    const target = resolve(normalize(targetAbs));
    if (target === root) return true;
    const rel = relative(root, target);
    if (!rel) return true;
    if (isAbsolute(rel)) return false;
    const segments = rel.split(sep);
    return !segments.some((s) => s === '..');
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

    if (!this.containsResolvedTarget(absolutePath)) {
      throw new PathValidationError(
        `Path traversal detected. "${userPath}" resolves outside the workspace.`
      );
    }

    return absolutePath;
  }

  toVirtualPath(absolutePath: string): string {
    const resolved = resolve(normalize(absolutePath));
    if (!this.containsResolvedTarget(resolved)) {
      throw new PathValidationError('Path is outside workspace.');
    }
    const root = this.workspaceRoot;
    if (resolved === root) return '/';
    const rel = relative(root, resolved);
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
