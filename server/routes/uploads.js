/**
 * Trek YSWS — Image Upload via Cloudinary
 *
 * POST /api/uploads
 *   - Accepts multipart/form-data with field "file"
 *   - Uploads to Cloudinary under the "trek" folder
 *   - Stores asset metadata in the DB (assets table)
 *   - Returns the short CDN-style URL to embed in journal markdown
 */

import { Router } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'orsdhud2',
    api_key:    process.env.CLOUDINARY_API_KEY || '899325484423145',
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/uploads
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    if (!req.body || !req.body.file) return res.status(400).json({ error: 'No file provided.' });

    const projectId = req.body.projectId || null;
    const fileDataUrl = req.body.file;
    const originalName = req.body.originalname || 'image.png';

    // Calculate approximate size from base64 (for database storage)
    const base64Str = fileDataUrl.split(',')[1] || '';
    const approximateSize = Math.floor(base64Str.length * 0.75);

    try {
        // Upload data URL to Cloudinary directly
        const cloudinaryResult = await cloudinary.uploader.upload(fileDataUrl, {
            folder: 'trek',
            resource_type: 'image',
            use_filename: false,
        });

        // Build a consistent short URL (matches the format from local api.js)
        const timeStamp = Date.now().toString(36);
        const randomHash = Math.random().toString(36).substring(2, 8);
        const ext = originalName.split('.').pop() || 'png';
        const shortUrl = `https://cdn.hackclub.com/trek/${timeStamp}_${randomHash}.${ext}`;

        // Store in assets table
        await query(
            `INSERT INTO assets (short_url, cloudinary_id, storage_url, file_name, file_size, project_id, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (short_url) DO NOTHING`,
            [
                shortUrl,
                cloudinaryResult.public_id,
                cloudinaryResult.secure_url,
                originalName,
                approximateSize,
                projectId,
                req.user.id,
            ]
        );

        res.json({
            url: shortUrl,
            storageUrl: cloudinaryResult.secure_url,
            markdown: `![${originalName.replace(/[^\w.-]+/g, '_')}](${shortUrl})`,
        });
    } catch (err) {
        console.warn('[Uploads] Cloudinary error, using PostgreSQL direct asset storage fallback:', err.message || err);
        
        try {
            // Safety Layer: Store directly in PostgreSQL assets table as data URI fallback
            const timeStamp = Date.now().toString(36);
            const randomHash = Math.random().toString(36).substring(2, 8);
            const ext = originalName.split('.').pop() || 'png';
            const shortUrl = `https://cdn.hackclub.com/trek/${timeStamp}_${randomHash}.${ext}`;
            const dataUrl = fileDataUrl;

            await query(
                `INSERT INTO assets (short_url, cloudinary_id, storage_url, file_name, file_size, project_id, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (short_url) DO NOTHING`,
                [
                    shortUrl,
                    `local_${randomHash}`,
                    dataUrl,
                    originalName,
                    approximateSize,
                    projectId,
                    req.user.id,
                ]
            );

            res.json({
                url: shortUrl,
                storageUrl: dataUrl,
                markdown: `![${originalName.replace(/[^\w.-]+/g, '_')}](${shortUrl})`,
            });
        } catch (dbErr) {
            console.error('[Uploads] Fallback storage error:', dbErr);
            res.status(500).json({ error: 'Image upload failed completely.' });
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/uploads/resolve?url=...
// Public asset resolution (returns storage_url for any short_url)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/resolve', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url param required' });

    try {
        const result = await query(
            `SELECT storage_url FROM assets WHERE short_url = $1 LIMIT 1`,
            [url]
        );
        if (result.rows.length === 0) return res.json({ url });
        res.json({ url: result.rows[0].storage_url });
    } catch (err) {
        res.json({ url });
    }
});

export default router;
