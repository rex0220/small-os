// ============================================================
// Shell — シェルプロセス（PID=2）
// ============================================================
import type { Kernel }    from '../kernel';
import type { Terminal }  from '../terminal/Terminal';
import type { SysHelper, SyscallResult } from '../types';
import { SYS }            from '../kernel/Syscall';
import { runLine }        from './Pipeline';

export class Shell {
  private sys: SysHelper;
  private shellPid: number;

  constructor(
    private readonly kernel: Kernel,
    private readonly term: Terminal,
    pid: number,
  ) {
    this.shellPid = pid;
    this.sys = this.makeSys(pid);
  }

  async attach(): Promise<void> {
    this.term.onInput(line => this.exec(line));
    await this.updatePrompt();
    this.term.print('small OS v0.1.0  (shell PID=' + this.shellPid + ')');
    this.term.print('Type "help" for available commands.\n');
  }

  private async exec(line: string): Promise<void> {
    // シェルプロセスが zombie になっていたら再起動
    const pcb = this.kernel.sched.get(this.shellPid);
    if (pcb?.state === 'zombie') {
      await this.restart();
      return;
    }
    await runLine(line, this.sys, this.term);
    await this.updatePrompt();
  }

  private async restart(): Promise<void> {
    this.term.print('\x1b[31mShell process terminated. Restarting...\x1b[0m');
    this.shellPid = await this.kernel.sched.fork(1, 'shell');
    this.sys = this.makeSys(this.shellPid);
    await this.updatePrompt();
    this.term.print('New shell PID=' + this.shellPid);
  }

  private async updatePrompt(): Promise<void> {
    const cwd = await this.sys.call(SYS.GETCWD) as string;
    this.term.setPrompt(cwd + ' $ ');
  }

  /** pid を束縛した SysHelper を生成する */
  private makeSys(pid: number): SysHelper {
    const kernel = this.kernel;
    return {
      pid,
      call: async (num, ...args) => {
        const result: SyscallResult = await kernel.syscall.call(pid, num, args);
        if (result.ok === false) throw Object.assign(new Error(result.message), { errno: result.errno });
        return result.value;
      },
    };
  }
}
