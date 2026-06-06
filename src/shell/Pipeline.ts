// ============================================================
// Pipeline — パイプ（|）・リダイレクト（>）実行エンジン
// ============================================================
import { SYS }           from '../kernel/Syscall';
import { OpenFlag }      from '../types';
import type { SysHelper } from '../types';
import type { Terminal }  from '../terminal/Terminal';
import { commands }       from './commands';
import { KernelError }    from '../kernel/KernelError';

export async function runLine(
  line: string,
  sys:  SysHelper,
  term: Terminal,
): Promise<void> {
  if (!line.trim()) return;

  // リダイレクト（>>）・（>）を先に解析
  let outFile: string | null = null;
  let append = false;
  const appendMatch = line.match(/^(.*?)\s*>>\s*(\S+)\s*$/);
  const writeMatch  = line.match(/^(.*?)\s*>\s*(\S+)\s*$/);
  if (appendMatch) { line = appendMatch[1]; outFile = appendMatch[2]; append = true; }
  else if (writeMatch) { line = writeMatch[1]; outFile = writeMatch[2]; }

  // パイプ（|）分割
  const segments = line.split('|').map(s => s.trim()).filter(Boolean);

  let stdin = '';
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const parts  = parseArgs(segments[i]);
    const cmd    = parts[0] ?? '';
    const args   = parts.slice(1);

    const fn = commands.get(cmd);
    if (!fn) {
      term.printError('small-os: ' + cmd + ': command not found');
      return;
    }

    let stdout = '';
    try {
      stdout = await fn(args, stdin, sys, term);
    } catch (e) {
      const msg = e instanceof KernelError ? e.message : (e as Error).message;
      term.printError(msg);
      return;
    }

    if (isLast) {
      if (outFile) {
        // リダイレクト出力
        try {
          const fd = await sys.call(SYS.OPEN, outFile, OpenFlag.WRITE) as number;
          const existing = append ? await sys.call(SYS.READ, fd).catch(() => '') as string : '';
          await sys.call(SYS.WRITE, fd, existing + stdout);
          await sys.call(SYS.CLOSE, fd);
        } catch (e) {
          term.printError((e as Error).message);
        }
      } else if (stdout) {
        term.print(stdout);
      }
    } else {
      stdin = stdout;
    }
  }
}

function parseArgs(input: string): string[] {
  const args: string[] = [];
  let cur   = '';
  let quote = '';
  for (const ch of input) {
    if (quote) {
      if (ch === quote) { quote = ''; }
      else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ') {
      if (cur) { args.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) args.push(cur);
  return args;
}
