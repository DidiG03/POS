import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

export const backupsRouter = Router();

const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups');

function ensureBackupsDir(businessCode: string) {
  const dir = path.join(BACKUPS_DIR, String(businessCode).replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.db')) {
      return cb(new Error('only .db files allowed'));
    }
    cb(null, true);
  },
});

// POST /backups/upload - Upload a backup file
// Auth: x-business-code + x-business-password headers
// Body: multipart/form-data with field "file" containing the .db file
backupsRouter.post('/upload', upload.single('file'), async (req, res) => {
  const file = (req as any).file;
  if (!file || !file.buffer) {
    return res.status(400).json({ error: 'no file in upload' });
  }
  const businessCode = String(req.headers['x-business-code'] || '').trim().toUpperCase();
  const password = String(req.headers['x-business-password'] || '').trim();
  if (!businessCode || !password) {
    return res.status(401).json({ error: 'x-business-code and x-business-password required' });
  }
  const biz = await prisma.business.findUnique({ where: { code: businessCode } }).catch(() => null);
  if (!biz || (biz as any).active === false) {
    return res.status(401).json({ error: 'invalid business' });
  }
  const hash = String((biz as any).accessPasswordHash || '').trim();
  if (!hash) return res.status(401).json({ error: 'backup upload not configured for this business' });
  const ok = await bcrypt.compare(password, hash).catch(() => false);
  if (!ok) return res.status(401).json({ error: 'invalid password' });
  const filename = (file.originalname || 'backup.db').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = ensureBackupsDir(businessCode);
  const dest = path.join(dir, filename);
  try {
    fs.writeFileSync(dest, file.buffer);
    return res.status(200).json({ ok: true, filename });
  } catch (e: any) {
    console.error('Backup upload failed', e);
    return res.status(500).json({ error: String(e?.message || 'upload failed') });
  }
});
