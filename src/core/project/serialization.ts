import { assertValidProject, type Project } from './model';

export function serializeProject(project: Project): string {
  assertValidProject(project);
  return JSON.stringify(project, null, 2);
}

export function deserializeProject(serialized: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error('Project data is not valid JSON.', { cause: error });
  }
  assertValidProject(parsed);
  return parsed;
}
