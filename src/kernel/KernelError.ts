// ============================================================
// KernelError — Linux ライクなエラー定義
// ============================================================

export const EPERM  = 1;   // Operation not permitted
export const ENOENT = 2;   // No such file or directory
export const ESRCH  = 3;   // No such process
export const EINTR  = 4;   // Interrupted system call
export const EBADF  = 9;   // Bad file descriptor
export const ENOMEM = 12;  // Cannot allocate memory
export const EACCES = 13;  // Permission denied
export const EEXIST = 17;  // File exists
export const ENOTDIR = 20; // Not a directory
export const EISDIR = 21;  // Is a directory
export const EINVAL = 22;  // Invalid argument
export const ENOSPC = 28;  // No space left on device

const errnoMessages: Record<number, string> = {
  [EPERM]:   'Operation not permitted',
  [ENOENT]:  'No such file or directory',
  [ESRCH]:   'No such process',
  [EINTR]:   'Interrupted system call',
  [EBADF]:   'Bad file descriptor',
  [ENOMEM]:  'Cannot allocate memory',
  [EACCES]:  'Permission denied',
  [EEXIST]:  'File exists',
  [ENOTDIR]: 'Not a directory',
  [EISDIR]:  'Is a directory',
  [EINVAL]:  'Invalid argument',
  [ENOSPC]:  'No space left on device',
};

export class KernelError extends Error {
  constructor(public readonly errno: number, context?: string) {
    const base = errnoMessages[errno] ?? 'Unknown error';
    super(context ? `${context}: ${base}` : base);
    this.name = 'KernelError';
  }
}

/** Linux ライク書式: "<cmd>: <target>: <message>" */
export function formatError(cmd: string, target: string, errno: number): string {
  const msg = errnoMessages[errno] ?? 'Unknown error';
  return `${cmd}: ${target}: ${msg}`;
}

/** カーネルパニックハンドラー — プロセスを zombie にしてエラー表示、継続 */
export function kernelPanic(pid: number, err: unknown, print: (s: string) => void): void {
  const msg = err instanceof KernelError ? err.message : String(err);
  print(`\x1b[31mKernel: process ${pid} terminated: ${msg}\x1b[0m`);
}
