/**
 * Trek YSWS — Automated Backup Job (Safety Layer 8)
 *
 * Runs a pg_dump every 6 hours and stores compressed .sql.gz files
 * in the BACKUP_DIR. Also removes backups older than 30 days.
 *
 * Can be run standalone:  node jobs/backup.js
 * Or scheduled via cron:  see server.js
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { createGzip } from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '../backups');
const KEEP_DAYS = 30;

export async function runBackup() {
    // Ensure backup directory exists
    mkdirSync(BACKUP_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `trek_backup_${timestamp}.sql`;
    const gzFilename = `${filename}.gz`;
    const gzPath = path.join(BACKUP_DIR, gzFilename);

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('[Backup] DATABASE_URL not set, skipping backup.');
        return;
    }

    console.log(`[Backup] Starting backup → ${gzFilename}`);

    try {
        // pg_dump writes SQL to stdout; we pipe it through gzip
        await new Promise((resolve, reject) => {
            const pgDump = execFile('pg_dump', [dbUrl, '--no-password'], { encoding: 'buffer' }, (err, stdout) => {
                if (err) { reject(err); return; }
                const gzip = createGzip({ level: 9 });
                const output = createWriteStream(gzPath);
                gzip.pipe(output);
                gzip.write(stdout);
                gzip.end();
                output.on('finish', resolve);
                output.on('error', reject);
            });
        });

        console.log(`[Backup] ✓ Backup saved: ${gzFilename}`);
    } catch (err) {
        console.error('[Backup] pg_dump failed:', err.message);
        // Non-fatal — server keeps running
    }

    // Purge backups older than KEEP_DAYS
    try {
        const files = readdirSync(BACKUP_DIR);
        const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        for (const file of files) {
            const filePath = path.join(BACKUP_DIR, file);
            const { mtimeMs } = statSync(filePath);
            if (mtimeMs < cutoff) {
                unlinkSync(filePath);
                console.log(`[Backup] Purged old backup: ${file}`);
            }
        }
    } catch (err) {
        console.warn('[Backup] Purge error:', err.message);
    }
}

// Allow direct execution: node jobs/backup.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runBackup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
