import type { SystemReport } from './system.js';
export type OsProbes = (targetDir: string) => Promise<SystemReport>;
export declare const osProbes: OsProbes;
