import { createClient } from '@libsql/client';
import fs from 'node:fs';
const dir = '/private/tmp/claude-501/-Users-sefridkapllani-Documents-GitHub-POS/6118f238-1985-4bb7-b783-fa0e17d1a91a/scratchpad/enc';
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/pos.db`;
const key = 'a'.repeat(64);
const c = createClient({ url: `file:${file}`, encryptionKey: key, concurrency: 1 } as any);
for (const p of ['PRAGMA journal_mode=WAL','PRAGMA synchronous=NORMAL','PRAGMA cache_size=-32768','PRAGMA mmap_size=0','PRAGMA wal_autocheckpoint=1000']) { try { console.log(p, (await c.execute(p)).rows[0]); } catch (e:any) { console.log('ERR', p, e.message); } }
await c.execute('CREATE TABLE SyncState (key TEXT PRIMARY KEY, valueJson TEXT, updatedAt TEXT)');
await c.execute('CREATE TABLE Filler (id INTEGER PRIMARY KEY, data TEXT)');
for (let i = 0; i < 80; i++) await c.execute({ sql: 'INSERT INTO Filler (data) VALUES (?)', args: ['x'.repeat(4000)] });
for (const size of [1000, 20000, 200000, 900000, 3000000]) {
  for (let n = 0; n < 5; n++) {
    const v = JSON.stringify({ blob: 'y'.repeat(size + n) });
    try {
      await c.execute({ sql: "INSERT INTO SyncState (key,valueJson,updatedAt) VALUES ('settings',?,?) ON CONFLICT(key) DO UPDATE SET valueJson=excluded.valueJson, updatedAt=excluded.updatedAt", args: [v, new Date().toISOString()] });
    } catch (e: any) { console.log('WRITE ERR size', size, e.code, e.message); }
  }
  console.log('size', size, 'file', fs.statSync(file).size, 'wal', fs.existsSync(file+'-wal') ? fs.statSync(file+'-wal').size : -1);
}
c.close();
// reopen like a restart
const d = createClient({ url: `file:${file}`, encryptionKey: key, concurrency: 1 } as any);
await d.execute('PRAGMA journal_mode=WAL'); await d.execute('PRAGMA mmap_size=0');
try { console.log('integrity', (await d.execute('PRAGMA integrity_check')).rows); } catch (e:any) { console.log('INTEGRITY ERR', e.message); }
try { await d.execute({ sql: "UPDATE SyncState SET valueJson=? WHERE key='settings'", args: [JSON.stringify({a:1})] }); console.log('update after reopen ok'); } catch (e:any) { console.log('UPDATE ERR', e.message); }
