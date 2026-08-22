/**
 * Trek YSWS — Journal Entries REST API
 *
 * Safety layers implemented here:
 *   - Safety Layer 7: Every edit creates a full snapshot in journal_history
 *   - Safety Layer 6: Soft deletes (deleted_at) — entries never truly gone
 *   - Safety Layer 9: Checksum stored with each entry to detect corruption
 *   - Safety Layer 1: Mutations wrapped in ACID transactions
 *
 * POST   /api/journals/:projectId          — create entry
 * PATCH  /api/journals/:projectId/:entryId — update entry (saves history)
 * DELETE /api/journals/:projectId/:entryId — soft-delete entry
 * GET    /api/journals/:projectId/:entryId/history — get edit history
 */

import { Router } from 'express';
import { createHash } from 'crypto';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeChecksum(content) {
    return createHash('sha256').update(content || '').digest('hex');
}

function rowToEntry(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        content: row.content,
        date: row.entry_date,
        timeSpent: row.time_spent,
        timeHours: parseFloat(row.time_hours) || 0,
        milestone: row.milestone,
        images: row.images || [],
        tags: row.tags || [],
        lapseUrl: row.lapse_url,
        status: 'published',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function assertProjectAccess(projectId, userId) {
    const res = await query(
        `SELECT p.id, p.user_id,
                (p.user_id = $2) as is_owner,
                EXISTS (
                    SELECT 1 FROM project_collaborators c
                    WHERE c.project_id = p.id AND c.user_id = $2 AND c.status = 'active'
                ) as is_collaborator
         FROM projects p
         WHERE p.id = $1 AND p.deleted_at IS NULL
           AND (p.user_id = $2 OR EXISTS (
               SELECT 1 FROM project_collaborators c
               WHERE c.project_id = p.id AND c.user_id = $2 AND c.status = 'active'
           ))`,
        [projectId, userId]
    );
    if (res.rows.length === 0) throw Object.assign(new Error('Project not found or access denied.'), { status: 404 });
    return res.rows[0];
}

async function assertProjectOwner(projectId, userId) {
    const res = await query(
        `SELECT p.id, p.user_id
         FROM projects p
         WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
        [projectId, userId]
    );
    if (res.rows.length === 0) throw Object.assign(new Error('Only the project owner can perform this action.'), { status: 403 });
    return res.rows[0];
}

async function recalcTotalHours(client, projectId) {
    await client.query(
        `UPDATE projects
         SET total_hours = (
             SELECT COALESCE(SUM(time_hours), 0)
             FROM journal_entries
             WHERE project_id = $1 AND deleted_at IS NULL
         )
         WHERE id = $1`,
        [projectId]
    );
}

function getContentText(text) {
    if (!text) return '';
    return text
        .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/[<>]/g, '')
        .trim();
}

function checkHasImage(text, images) {
    if (Array.isArray(images) && images.length > 0) return true;
    if (!text) return false;
    return (text.includes('![') && text.includes('](')) || text.includes('<img');
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/journals/:projectId
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:projectId', async (req, res) => {
    const { projectId } = req.params;
    try {
        await assertProjectAccess(projectId, req.user.id);

        const { title, content, date, timeSpent, timeHours, milestone, images, tags, lapseUrl } = req.body;
        if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
        if (!content?.trim()) return res.status(400).json({ error: 'Content is required.' });

        const textOnly = getContentText(content);
        if (textOnly.length < 80) {
            return res.status(400).json({ error: `Build log is too short (${textOnly.length}/80 characters). Please write at least 80 characters.` });
        }

        if (!checkHasImage(content, images)) {
            return res.status(400).json({ error: 'Please attach at least 1 image/photo proof of your build progress.' });
        }

        const entryId = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const checksum = computeChecksum(content);
        const parsedHours = parseFloat(timeHours) || 0;

        // Duplicate guard: prevent double-clicks/retries within 5 seconds
        const duplicateCheck = await query(
            `SELECT * FROM journal_entries
             WHERE project_id = $1 AND title = $2 AND checksum = $3 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '5 seconds'
             LIMIT 1`,
            [projectId, title.trim(), checksum]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.json(rowToEntry(duplicateCheck.rows[0]));
        }

        const entry = await withTransaction(async (client) => {
            const insertRes = await client.query(
                `INSERT INTO journal_entries
                    (id, project_id, author_id, title, content, entry_date, time_spent, time_hours, milestone, images, tags, lapse_url, checksum)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [
                    entryId, projectId, req.user.id,
                    title.trim(), content.trim(),
                    date || new Date().toISOString().split('T')[0],
                    timeSpent || '1 hr', parsedHours,
                    milestone || 'general',
                    JSON.stringify(images || []),
                    JSON.stringify(tags || []),
                    lapseUrl || null,
                    checksum,
                ]
            );

            // Mark project as in_progress if it was draft
            await client.query(
                `UPDATE projects SET status = 'in_progress'
                 WHERE id = $1 AND status = 'draft'`,
                [projectId]
            );

            await recalcTotalHours(client, projectId);
            return insertRes.rows[0];
        });

        // Attach author info
        entry.author_name = req.user.display_name;
        entry.author_avatar = req.user.avatar_url;

        res.status(201).json(rowToEntry(entry));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Journals] POST error:', err);
        res.status(500).json({ error: 'Failed to create journal entry.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/journals/:projectId/:entryId
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:projectId/:entryId', async (req, res) => {
    const { projectId, entryId } = req.params;
    try {
        await assertProjectAccess(projectId, req.user.id);

        // Fetch current entry for history snapshot
        const currentRes = await query(
            `SELECT * FROM journal_entries WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
            [entryId, projectId]
        );
        if (currentRes.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });
        const current = currentRes.rows[0];

        const { title, content, date, timeSpent, timeHours, milestone, images, tags, lapseUrl } = req.body;
        const newContent = content ?? current.content;
        const checksum = computeChecksum(newContent);
        const parsedHours = timeHours !== undefined ? parseFloat(timeHours) || 0 : parseFloat(current.time_hours);

        const updated = await withTransaction(async (client) => {
            // Safety Layer 7: Save full history snapshot BEFORE updating
            await client.query(
                `INSERT INTO journal_history (entry_id, snapshot, edited_by)
                 VALUES ($1, $2, $3)`,
                [entryId, JSON.stringify(rowToEntry(current)), req.user.id]
            );

            const updateRes = await client.query(
                `UPDATE journal_entries SET
                    title      = COALESCE($1, title),
                    content    = COALESCE($2, content),
                    entry_date = COALESCE($3, entry_date),
                    time_spent = COALESCE($4, time_spent),
                    time_hours = $5,
                    milestone  = COALESCE($6, milestone),
                    images     = COALESCE($7, images),
                    tags       = COALESCE($8, tags),
                    lapse_url  = COALESCE($9, lapse_url),
                    checksum   = $10
                 WHERE id = $11 AND project_id = $12 AND deleted_at IS NULL
                 RETURNING *`,
                [
                    title?.trim() ?? null,
                    newContent?.trim() ?? null,
                    date ?? null,
                    timeSpent ?? null,
                    parsedHours,
                    milestone ?? null,
                    images ? JSON.stringify(images) : null,
                    tags ? JSON.stringify(tags) : null,
                    lapseUrl ?? null,
                    checksum,
                    entryId, projectId,
                ]
            );

            await recalcTotalHours(client, projectId);
            return updateRes.rows[0];
        });

        res.json(rowToEntry(updated));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Journals] PATCH error:', err);
        res.status(500).json({ error: 'Failed to update journal entry.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/journals/:projectId/:entryId  (soft delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:projectId/:entryId', async (req, res) => {
    const { projectId, entryId } = req.params;
    try {
        await assertProjectAccess(projectId, req.user.id);

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE journal_entries SET deleted_at = NOW()
                 WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
                [entryId, projectId]
            );
            await recalcTotalHours(client, projectId);
        });

        res.json({ success: true });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Journals] DELETE error:', err);
        res.status(500).json({ error: 'Failed to delete journal entry.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/journals/:projectId/:entryId/history
// Returns all previous versions of an entry
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:projectId/:entryId/history', async (req, res) => {
    const { projectId, entryId } = req.params;
    try {
        await assertProjectAccess(projectId, req.user.id);

        const histRes = await query(
            `SELECT h.*, u.display_name
             FROM journal_history h
             LEFT JOIN users u ON u.id = h.edited_by
             WHERE h.entry_id = $1
             ORDER BY h.edited_at DESC`,
            [entryId]
        );

        res.json(histRes.rows.map(r => ({
            id: r.id,
            snapshot: r.snapshot,
            editedBy: r.display_name || 'Unknown',
            editedAt: r.edited_at,
        })));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Journals] GET history error:', err);
        res.status(500).json({ error: 'Failed to fetch history.' });
    }
});

export default router;
