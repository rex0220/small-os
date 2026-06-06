// ============================================================
// process.worker.ts — 協調スケジューリング用プロセス Worker
// ============================================================
import type { WorkerMessage, SyscallResult } from '../types';

let callIdCounter = 0;
const pendingSyscalls = new Map<number, (r: SyscallResult) => void>();
let resumeResolve: (() => void) | null = null;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'resume') {
    resumeResolve?.();
    resumeResolve = null;
  }
  if (msg.type === 'syscall_result') {
    pendingSyscalls.get(msg.callId)?.(msg.result);
    pendingSyscalls.delete(msg.callId);
  }
};

/** スケジューラーへ制御を返す */
export async function yieldControl(): Promise<void> {
  postMessage({ type: 'yield' } satisfies WorkerMessage);
  await new Promise<void>(resolve => { resumeResolve = resolve; });
}

/** システムコール発行（非同期） */
export async function syscall(num: number, ...args: unknown[]): Promise<SyscallResult> {
  const callId = callIdCounter++;
  return new Promise<SyscallResult>(resolve => {
    pendingSyscalls.set(callId, resolve);
    postMessage({ type: 'syscall', callId, num, args } satisfies WorkerMessage);
  });
}

/** stdout へ出力 */
export function print(text: string): void {
  postMessage({ type: 'stdout', text } satisfies WorkerMessage);
}

/** プロセス終了 */
export function exit(code = 0): void {
  postMessage({ type: 'exit', code } satisfies WorkerMessage);
}
