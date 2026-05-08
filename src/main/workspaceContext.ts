import { resolve } from 'node:path';
import { PathValidator } from './security/pathValidator';

let validator: PathValidator = new PathValidator(resolve('.'));

export function getPathValidator(): PathValidator {
  return validator;
}

export function setWorkspaceRoot(absolutePath: string): void {
  validator = new PathValidator(resolve(absolutePath));
}
