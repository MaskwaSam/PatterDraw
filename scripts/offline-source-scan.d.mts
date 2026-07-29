export const sourceExtensions: ReadonlySet<string>;
export const remoteSourceRules: ReadonlyArray<readonly [RegExp, string]>;
export const remoteCssRules: ReadonlyArray<readonly [RegExp, string]>;

export function isScannableSourceFile(fileName: string): boolean;
export function findRemoteSourceReferences(
  source: string,
  relativeFile: string,
): string[];
export function findRemoteSourceFindings(
  root: string,
  scanRoots: readonly string[],
): Promise<string[]>;
