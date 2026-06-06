// ============================================================
// コマンドレジストリ — すべてのカーネルアクセスは SysHelper 経由
// ============================================================
import { SYS }           from '../../kernel/Syscall';
import { OpenFlag }      from '../../types';
import type { SysHelper, DirEntry, Inode } from '../../types';
import type { Terminal } from '../../terminal/Terminal';

export type CmdFn = (
  args:  string[],
  stdin: string,
  sys:   SysHelper,
  term:  Terminal,
) => Promise<string>;

export const commands = new Map<string, CmdFn>();

// ── コマンド登録 ──────────────────────────────────────────────

commands.set('help', async () => {
  return [
    'Available commands:',
    '  help               show this message',
    '  clear              clear screen',
    '  echo <text>        print text',
    '  date               show current date/time',
    '  pwd                print working directory',
    '  ls [path]          list directory',
    '  cd <path>          change directory',
    '  mkdir <path>       create directory',
    '  touch <file>       create file',
    '  cat <file>         print file contents',
    '  wc <file>          count lines, words, bytes',
    '  istat <path>       show inode metadata',
    '  rm <file>          remove file',
    '  ps                 list processes',
    '  kill <pid>         terminate process',
    '  free               show memory usage',
    '  memmap             show memory page map',
    '  stress [n]         fork workers until memory pressure',
    '  uptime             show timer ticks',
  ].join('\n');
});

commands.set('clear', async (_a, _i, _s, term) => {
  term.clear();
  return '';
});

commands.set('echo', async (args) => {
  if (args[0] === '-n') return args.slice(1).join(' ');
  return args.join(' ');
});

commands.set('date', async () => new Date().toLocaleString('ja-JP'));

commands.set('pwd', async (_args, _stdin, sys) => {
  return await sys.call(SYS.GETCWD) as string;
});

commands.set('ls', async (args, _stdin, sys) => {
  const path    = args[0] ?? '.';
  const entries = await sys.call(SYS.READDIR, path) as DirEntry[];
  const lines: string[] = [];
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const entryPath = path === '.' ? e.name : path.replace(/\/$/, '') + '/' + e.name;
    const inode = await sys.call(SYS.STAT, entryPath).catch(() => null) as Inode | null;
    lines.push(inode?.type === 'dir' ? '\x1b[33m' + e.name + '/\x1b[0m' : e.name);
  }
  return lines.join('\n');
});

commands.set('cd', async (args, _stdin, sys) => {
  await sys.call(SYS.CHDIR, args[0] ?? '/');
  return '';
});

commands.set('mkdir', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('mkdir: missing operand');
  await sys.call(SYS.MKDIR, args[0]);
  return '';
});

commands.set('touch', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('touch: missing file operand');
  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.WRITE) as number;
  await sys.call(SYS.CLOSE, fd);
  return '';
});

commands.set('cat', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('cat: missing operand');
  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  try {
    return await sys.call(SYS.READ, fd) as string;
  } finally {
    await sys.call(SYS.CLOSE, fd);
  }
});

commands.set('wc', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('wc: missing operand');

  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  try {
    const text = await sys.call(SYS.READ, fd) as string;
    const lines = text.split('\n').length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(text).length;
    return `${lines} ${words} ${bytes} ${args[0]}`;
  } finally {
    await sys.call(SYS.CLOSE, fd);
  }
});

commands.set('istat', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('istat: missing operand');

  const inode = await sys.call(SYS.STAT, args[0]) as Inode;
  const fmt = (ts: number) => new Date(ts).toLocaleString('ja-JP');
  return [
    'inode:    ' + inode.id,
    'type:     ' + inode.type,
    'size:     ' + inode.size,
    'links:    ' + inode.nlink,
    'created:  ' + fmt(inode.created),
    'modified: ' + fmt(inode.modified),
  ].join('\n');
});

commands.set('rm', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('rm: missing operand');
  await sys.call(SYS.UNLINK, args[0]);
  return '';
});

commands.set('ps', async (_args, _stdin, sys) => {
  type PsRow = { pid: number; ppid: number; name: string; state: string; cpu: number; elapsed: number };
  const list = await sys.call(SYS.PS) as PsRow[];
  const header = 'PID  PPID  STATE    CPU_MS  ELAPSED  NAME';
  const rows = list.map(p =>
    String(p.pid).padEnd(5) +
    String(p.ppid).padEnd(6) +
    p.state.padEnd(9) +
    String(p.cpu).padEnd(8) +
    (p.elapsed + 's').padEnd(9) +
    p.name
  );
  return [header, ...rows].join('\n');
});

commands.set('kill', async (args, _stdin, sys) => {
  const pid = parseInt(args[0] ?? '');
  if (isNaN(pid)) throw new Error('kill: ' + args[0] + ': invalid argument');
  await sys.call(SYS.KILL, pid);
  return '';
});

commands.set('free', async (_args, _stdin, sys) => {
  const info = await sys.call(SYS.MEMINFO) as { used: number; free: number; total: number };
  const PAGE_SIZE = 4096;
  const usedPages = info.used / PAGE_SIZE;
  const totalPages = info.total / PAGE_SIZE;
  const kb = (n: number) => String(Math.round(n / 1024)) + 'K';
  return [
    '              total        used        free   pages',
    'Mem:  ' +
      kb(info.total).padStart(12) +
      kb(info.used).padStart(12) +
      kb(info.free).padStart(12) +
      `   ${usedPages}/${totalPages}`,
  ].join('\n');
});

commands.set('memmap', async (_args, _stdin, sys) => {
  const pages = await sys.call(SYS.MEMMAP) as number[];
  const cells = pages.map(pid => pid === 0 ? '.' : String(pid)).join('][');
  return [
    `Page map (${pages.length} pages, 4KB each):`,
    '[' + cells + ']',
    ' . = 空き  数字 = 使用中 PID',
  ].join('\n');
});

commands.set('stress', async (args, _stdin, sys) => {
  const count = parseInt(args[0] ?? '5');
  if (isNaN(count) || count < 1) throw new Error('stress: invalid count');
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    try {
      await sys.call(SYS.FORK, 'stress-worker');
      spawned++;
    } catch (e) {
      return `Spawned ${spawned}/${count} workers. OOM: ${(e as Error).message}`;
    }
  }
  return `Spawned ${spawned} workers. Run 'free' or 'memmap' to observe.`;
});

commands.set('uptime', async (_args, _stdin, sys) => {
  const info = await sys.call(SYS.UPTIME) as { ticks: number; ms: number };
  return `System uptime: ${info.ticks} ticks (${info.ms}ms)`;
});
