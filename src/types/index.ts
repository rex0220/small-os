// ============================================================
// shared types
// ============================================================

export interface MemorySegment {
  base: number;
  size: number;
  pages: number[];
}

export type ProcessState = 'running' | 'ready' | 'waiting' | 'zombie';

export interface PCB {
  pid: number;
  ppid: number;
  name: string;
  state: ProcessState;
  priority: number;
  worker: Worker;
  memory: MemorySegment;
  openFiles: number[];
  startTime: number;
  cpuTime: number;
  cwd: number;       // カレントディレクトリの inode ID（デフォルト: 1 = /）
}

export interface Inode {
  id: number;
  type: 'file' | 'dir';
  size: number;
  created: number;
  modified: number;
  data: string;
  nlink: number;
}

export interface DirEntry {
  name: string;
  inode: number;
}

export interface FileDescriptor {
  fd: number;
  inodeId: number;
  offset: number;
  flags: OpenFlag;
}

export enum OpenFlag {
  READ = 0,
  WRITE = 1,
  APPEND = 2,
}

export type SyscallResult =
  | { ok: true; value: unknown }
  | { ok: false; errno: number; message: string };

// Worker message protocol
export type WorkerMessage =
  | { type: 'yield' }
  | { type: 'resume' }
  | { type: 'syscall'; callId: number; num: number; args: unknown[] }
  | { type: 'syscall_result'; callId: number; result: SyscallResult }
  | { type: 'stdout'; text: string }
  | { type: 'exit'; code: number };

/**
 * ユーザー空間からカーネルへのアクセス窓口。
 * コマンド・シェルはこのインターフェース経由でのみカーネルを呼ぶ。
 * 失敗時は KernelError を throw する。
 */
export interface SysHelper {
  readonly pid: number;
  call(num: number, ...args: unknown[]): Promise<unknown>;
}
