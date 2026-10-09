import type { Project } from './model';

/** Storage contract for a later local IndexedDB adapter. No network persistence is used. */
export interface ProjectPersistence {
  load(projectId: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
  delete(projectId: string): Promise<void>;
}
