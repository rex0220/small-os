// ============================================================
// Terminal — DOM ベース端末エミュレーター
// 入力行は出力フローの末尾に配置（本物のターミナル風）
// ============================================================

export type InputHandler = (line: string) => Promise<void>;

export class Terminal {
  private output:    HTMLElement;
  private inputLine: HTMLElement;
  private promptEl:  HTMLElement;
  private input:     HTMLInputElement;
  private history:   string[] = [];
  private histIdx:   number   = -1;
  private promptText = '$ ';

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `<div id="os-output"></div>`;
    this.output    = root.querySelector('#os-output')!;
    this.inputLine = this.createInputLine();
    this.output.appendChild(this.inputLine);
    this.promptEl  = this.inputLine.querySelector('.os-prompt')!;
    this.input     = this.inputLine.querySelector('.os-input')!;
    this.input.addEventListener('keydown', e => this.onKey(e));
    root.addEventListener('click', () => this.input.focus());
    this.input.focus();
  }

  onInput(handler: InputHandler): void { this._handler = handler; }
  private _handler: InputHandler = async () => {};

  print(text: string, className = ''): void {
    if (!text) return;
    for (const line of text.split('\n')) {
      const div = document.createElement('div');
      div.className = 'os-line' + (className ? ' ' + className : '');
      div.innerHTML = ansiToHtml(escapeHtml(line));
      this.output.insertBefore(div, this.inputLine);
    }
    this.scrollToBottom();
  }

  printError(text: string): void { this.print(text, 'os-error'); }

  setPrompt(p: string): void {
    this.promptText = p;
    this.promptEl.innerHTML = ansiToHtml(escapeHtml(p));
  }

  clear(): void {
    Array.from(this.output.children).forEach(c => {
      if (c !== this.inputLine) c.remove();
    });
  }

  lock(): void   { this.input.disabled = true; }
  unlock(): void { this.input.disabled = false; this.input.focus(); }

  private async onKey(e: KeyboardEvent): Promise<void> {
    if (e.key === 'Enter') {
      const line = this.input.value;
      this.input.value = '';
      this.histIdx = -1;
      if (line.trim()) this.history.unshift(line);

      const echo = document.createElement('div');
      echo.className = 'os-line os-cmd';
      echo.innerHTML = ansiToHtml(escapeHtml(this.promptText)) + escapeHtml(line);
      this.output.insertBefore(echo, this.inputLine);

      this.lock();
      try { await this._handler(line.trim()); } catch { /* ignore */ }
      this.unlock();
      this.scrollToBottom();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.histIdx < this.history.length - 1) {
        this.histIdx++;
        this.input.value = this.history[this.histIdx] ?? '';
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.histIdx > 0) {
        this.histIdx--;
        this.input.value = this.history[this.histIdx] ?? '';
      } else {
        this.histIdx = -1;
        this.input.value = '';
      }
    }
  }

  private createInputLine(): HTMLElement {
    const div = document.createElement('div');
    div.id = 'os-input-line';
    div.innerHTML = `<span class="os-prompt"></span><input class="os-input" type="text" autocomplete="off" spellcheck="false" />`;
    return div;
  }

  private scrollToBottom(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ansiToHtml(s: string): string {
  return s
    .replace(/\x1b\[31m(.*?)\x1b\[0m/g, '<span class="ansi-red">$1</span>')
    .replace(/\x1b\[32m(.*?)\x1b\[0m/g, '<span class="ansi-green">$1</span>')
    .replace(/\x1b\[33m(.*?)\x1b\[0m/g, '<span class="ansi-yellow">$1</span>')
    .replace(/\x1b\[0m/g, '');
}
