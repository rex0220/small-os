import './terminal/terminal.css';
import { kernel }   from './kernel';
import { Terminal } from './terminal/Terminal';
import { Shell }    from './shell/Shell';

async function main() {
  const root = document.getElementById('terminal')!;
  const term = new Terminal(root);

  // カーネル起動 → シェルプロセスの PID を受け取る
  const shellPid = await kernel.boot((text) => term.print(text));

  const shell = new Shell(kernel, term, shellPid);
  await shell.attach();
}

main().catch(console.error);
