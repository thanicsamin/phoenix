import { spawn } from 'node:child_process';
import { secret } from '../src/config.js';
import { lifecycle } from '../src/host.js';
import { log } from '../src/log.js';

export default function tunnel(pi, host, options) {
  let child;
  lifecycle(pi, host, 'tunnel', async () => {
    if (!host.port) throw new Error('Web extension must start before the tunnel.');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SSL_CERT_FILE: process.env.SSL_CERT_FILE };
    const args = ['tunnel', '--no-autoupdate'];
    if (options.mode === 'named') {
      env.TUNNEL_TOKEN = await secret('CLOUDFLARE_TUNNEL_TOKEN');
      host.publicUrl = options.url;
      args.push('run');
    } else args.push('--url', `http://127.0.0.1:${host.port}`);
    child = spawn('cloudflared', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel did not become ready within 45 seconds.')), 45000);
      const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      let buffer = '';
      child.once('error', () => done(new Error('Install cloudflared or disable the tunnel extension.')));
      child.once('exit', (code, signal) => {
        log[code ? 'warn' : 'info']('tunnel.exited', { code, signal });
        host.extensions.tunnel = 'failed'; host.changed();
        done(new Error('Tunnel exited. The local browser link still works.'));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        buffer = (buffer + chunk).slice(-8000);
        const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (url && !host.publicUrl) { host.publicUrl = url[0]; log.info('tunnel.ready', { url: host.publicUrl }); done(); }
        if (options.mode === 'named' && buffer.includes('Registered tunnel connection')) { log.info('tunnel.ready', { url: host.publicUrl }); done(); }
      });
    }).catch(error => { child.kill('SIGTERM'); throw error; });
  }, async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  });
}
