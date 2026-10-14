import http from 'node:http';
import { readConfig } from '../src/config.mjs';

// 健康检查沿用运行配置的精确 Host，不绕过生产 Host 校验。
const config = readConfig(process.argv[2] ?? '/config/relay.json');
const request = http.get({ host: config.listenHost, port: config.listenPort, path: '/healthz',
  headers: { Host: config.publicHost }, timeout: 2000 }, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; if (body.length > 128) request.destroy(); });
  response.on('end', () => {
    process.exitCode = response.statusCode === 200 && body === '{"ok":true}' ? 0 : 1;
  });
  response.on('error', () => { process.exitCode = 1; });
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
