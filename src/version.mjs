/**
 * 版本号单一真源：从 package.json 读，不在代码里硬编码。
 *
 * 起因：--help 里的版本字符串停在 v0.3.1，而实际发布的是 v0.5.1——
 * 历次发版 sed 漏掉了那一处。同事看到的版本号和真正跑的代码对不上，
 * 报 bug 时会指向错的版本。「双份必然漂移」的又一例。
 */
import { readFileSync } from 'node:fs';

let cached = null;
export function version() {
  if (cached) return cached;
  try {
    const p = new URL('../package.json', import.meta.url);
    cached = JSON.parse(readFileSync(p, 'utf8')).version || '0.0.0';
  } catch { cached = '0.0.0'; }
  return cached;
}
