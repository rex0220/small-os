// ============================================================
// Syscall -- async syscall layer (user/kernel boundary)
// ============================================================
import type { SyscallResult } from '../types';
import { OpenFlag } from '../types';
import type { FileSystem } from './FileSystem';
import type { Scheduler } from './Scheduler';
import type { MemoryManager } from './MemoryManager';

export enum SYS {
  READ    = 0,
  WRITE   = 1,
  OPEN    = 2,
  CLOSE   = 3,
  FORK    = 4,
  EXIT    = 5,
  GETPID  = 6,
  KILL    = 7,
  MKDIR   = 8,
  UNLINK  = 9,
  STAT    = 10,
  READDIR = 11,
  CHDIR   = 12,
  GETCWD  = 13,
  MEMINFO = 14,
  PS      = 15,
  MEMMAP  = 16,
  UPTIME  = 17,
}

export class Syscall {
  constructor(
    private readonly fs:     FileSystem,
    private readonly sched:  Scheduler,
    private readonly memory: MemoryManager,
    private readonly getTicks: () => number = () => 0,
  ) {}

  async call(pid: number, num: number, args: unknown[]): Promise<SyscallResult> {
    try {
      const value = await this.dispatch(pid, num as SYS, args);
      return { ok: true, value };
    } catch (e) {
      const err = e as { errno?: number; message?: string };
      return { ok: false, errno: err.errno ?? 22, message: err.message ?? String(e) };
    }
  }

  private handlePs() {
    const now = Date.now();
    return this.sched.list().map(p => ({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      state: p.state,
      cpu: p.cpuTime,
      start: p.startTime,
      elapsed: Math.floor((now - p.startTime) / 1000),
    }));
  }

  private async handleExit(pid: number, code: number): Promise<void> {
    await this.sched.exit(pid, code);
  }

  private getCwd(pid: number): number {
    return this.sched.get(pid)?.cwd ?? 1;
  }

  private async dispatch(pid: number, num: SYS, args: unknown[]): Promise<unknown> {
    const cwd = this.getCwd(pid);
    switch (num) {
      case SYS.READ:    return await this.fs.read(args[0] as number, pid);
      case SYS.WRITE:   return await this.fs.write(args[0] as number, args[1] as string, pid);
      case SYS.OPEN:    return await this.fs.open(args[0] as string, args[1] as OpenFlag, cwd, pid);
      case SYS.CLOSE:   return await this.fs.close(args[0] as number, pid);
      case SYS.FORK:    return await this.sched.fork(pid, args[0] as string);
      case SYS.EXIT:    return await this.handleExit(pid, (args[0] as number) ?? 0);
      case SYS.GETPID:  return pid;
      case SYS.KILL:    return await this.sched.kill(args[0] as number, pid);
      case SYS.MKDIR:   return await this.fs.mkdir(args[0] as string, cwd);
      case SYS.UNLINK:  return await this.fs.unlink(args[0] as string, cwd);
      case SYS.STAT:    return await this.fs.stat(args[0] as string, cwd);
      case SYS.READDIR: return await this.fs.readdir(args[0] as string, cwd);
      case SYS.CHDIR: {
        const newCwd = await this.fs.chdir(args[0] as string, cwd);
        const pcb = this.sched.get(pid);
        if (pcb) pcb.cwd = newCwd;
        return undefined;
      }
      case SYS.GETCWD:  return this.fs.buildPath(cwd);
      case SYS.MEMINFO: return this.memory.getUsage();
      case SYS.PS:      return this.handlePs();
      case SYS.MEMMAP:  return this.memory.getPageMap();
      case SYS.UPTIME:  return { ticks: this.getTicks(), ms: this.getTicks() * 50 };
      default:          throw Object.assign(new Error('Unknown syscall: ' + num), { errno: 22 });
    }
  }
}
