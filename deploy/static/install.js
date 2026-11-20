'use strict';

function terminalPlatform() {
  const { userAgentData, userAgent, platform, maxTouchPoints } = navigator;
  if (userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent) ||
      (/^Mac/.test(platform) && maxTouchPoints > 1)) return null;
  const os = userAgentData?.platform || platform || userAgent;
  if (/Windows|^Win/i.test(os)) return 'windows';
  if (/Mac|Linux|CrOS/i.test(os)) return 'shell';
  return null;
}

function installCommand(product, platform) {
  const filename = product === 'harness' ? 'Harness' : 'AWG-Launcher';
  const url = 'https://ebuilde.ru/' + product + '/download';
  if (platform === 'windows') {
    return `& { $ErrorActionPreference = 'Stop'; $file = Join-Path ([IO.Path]::GetTempPath()) ('${filename}-' + [guid]::NewGuid() + '.vsix'); try { Invoke-WebRequest -UseBasicParsing '${url}' -OutFile $file; code --install-extension $file; if ($LASTEXITCODE -ne 0) { throw "VS Code: $LASTEXITCODE" } } finally { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file } } }`;
  }
  return `(dir=$(mktemp -d) && trap 'rm -f "$dir/${filename}.vsix"; rmdir "$dir"' EXIT && curl -fsSL '${url}' -o "$dir/${filename}.vsix" && code --install-extension "$dir/${filename}.vsix")`;
}

const platform = terminalPlatform();
for (const block of document.querySelectorAll('.install-command')) {
  if (!platform || !['harness', 'awg'].includes(block.dataset.product)) continue;
  const button = block.querySelector('button');
  const command = block.querySelector('code');
  command.textContent = installCommand(block.dataset.product, platform);
  command.setAttribute('aria-label', platform === 'windows' ? 'Команда для PowerShell' : 'Команда для терминала');
  let reset;
  block.hidden = false;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(command.textContent);
      button.textContent = 'Скопировано';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      button.textContent = 'Выделено';
    }
    reset = setTimeout(() => { button.textContent = 'Скопировать'; }, 1800);
  });
}
