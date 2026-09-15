const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, ...options });
try {
  docker(['info', '--format', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  console.error('Docker is not running. Start Docker Desktop, then run npm run start:searxng again.');
  process.exit(1);
}
try {
  const names = docker(['ps', '-a', '--format', '{{.Names}}']).trim().split(/\r?\n/);
  if (names.includes('searxng')) {
    const image = docker(['inspect', '--format', '{{.Config.Image}}', 'searxng']).trim();
    if (!/^(?:docker\.io\/)?searxng\/searxng(?=[:@]|$)/.test(image)) {
      throw new Error('A container named searxng already exists with another image. Existing container left unchanged.');
    }
    docker(['start', 'searxng'], { stdio: 'inherit' });
  } else {
    const dir = path.resolve(__dirname, '../searxng');
    fs.mkdirSync(dir, { recursive: true });
    const settings = path.join(dir, 'settings.yml');
    if (!fs.existsSync(settings)) {
      fs.writeFileSync(settings, `use_default_settings: true\nserver:\n  secret_key: "${randomBytes(32).toString('hex')}"\n  limiter: false\nsearch:\n  formats: [html, json]\nengines:\n  - name: google\n    disabled: false\n  - name: bing\n    disabled: false\n  - name: duckduckgo\n    disabled: false\n  - name: brave\n    disabled: false\n`);
    }
    docker(['run', '-d', '--name', 'searxng', '--restart', 'unless-stopped', '-p', '127.0.0.1:8080:8080',
      '--mount', `type=bind,source=${dir},target=/etc/searxng`, 'searxng/searxng:latest'], { stdio: 'inherit' });
  }
  console.log('SearXNG started. Use http://localhost:8080 in Own Search, then click Test connection.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
