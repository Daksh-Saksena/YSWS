/**
 * Trek YSWS — Projects REST API
 *
 * All routes require JWT auth.
 * Users can only read/write their own projects.
 *
 * GET    /api/projects           — list all projects for current user
 * POST   /api/projects           — create a new project
 * GET    /api/projects/:id       — get one project with all journal entries
 * PATCH  /api/projects/:id       — update project metadata
 * DELETE /api/projects/:id       — soft-delete a project
 * POST   /api/projects/:id/submit — submit for review
 */

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All project routes require auth
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function rowToProject(row, entries = []) {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        guild: row.guild,
        tagline: row.tagline || '',
        description: row.description || '',
        coverImageUrl: row.cover_image_url || 'jet.png',
        status: row.status,
        reviewType: row.review_type,
        linkedDesignProjectId: row.linked_design_project_id,
        repoUrl: row.repo_url,
        totalHours: parseFloat(row.total_hours) || 0,
        version: row.version,
        submittedAt: row.submitted_at,
        reviewFeedback: row.review_feedback,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        authorName: row.display_name || 'Trek Builder',
        authorAvatar: row.avatar_url || 'images/flag.png',
        journalEntries: entries,
    };
}

function rowToEntry(row) {
    let dateStr = '';
    if (row.entry_date instanceof Date) {
        dateStr = row.entry_date.toISOString().split('T')[0];
    } else if (row.entry_date) {
        dateStr = String(row.entry_date).split('T')[0];
    } else {
        dateStr = new Date().toISOString().split('T')[0];
    }

    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        content: row.content,
        date: dateStr,
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

async function getProjectWithEntries(projectId, userId) {
    const [pRes, eRes, aRes] = await Promise.all([
        query(
            `SELECT p.*, u.display_name, u.avatar_url
             FROM projects p
             JOIN users u ON u.id = p.user_id
             WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
            [projectId, userId]
        ),
        query(
            `SELECT * FROM journal_entries
             WHERE project_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [projectId]
        ),
        query(
            `SELECT short_url, storage_url FROM assets WHERE project_id = $1 OR uploaded_by = $2`,
            [projectId, userId]
        )
    ]);

    if (pRes.rows.length === 0) return null;

    const assetsMap = {};
    for (const a of aRes.rows) {
        assetsMap[a.short_url] = a.storage_url;
    }

    const project = rowToProject(pRes.rows[0], eRes.rows.map(rowToEntry));
    project.assets = assetsMap;
    return project;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [projectsRes, entriesRes] = await Promise.all([
            query(
                `SELECT p.*, u.display_name, u.avatar_url
                 FROM projects p
                 JOIN users u ON u.id = p.user_id
                 WHERE p.user_id = $1 AND p.deleted_at IS NULL
                 ORDER BY p.created_at DESC`,
                [req.user.id]
            ),
            query(
                `SELECT j.* FROM journal_entries j
                 JOIN projects p ON p.id = j.project_id
                 WHERE p.user_id = $1 AND j.deleted_at IS NULL AND p.deleted_at IS NULL
                 ORDER BY j.created_at DESC`,
                [req.user.id]
            )
        ]);

        const entriesByProject = {};
        for (const e of entriesRes.rows) {
            if (!entriesByProject[e.project_id]) entriesByProject[e.project_id] = [];
            entriesByProject[e.project_id].push(rowToEntry(e));
        }

        const projects = projectsRes.rows.map(row => {
            return rowToProject(row, entriesByProject[row.id] || []);
        });

        res.json(projects);
    } catch (err) {
        console.error('[Projects] GET / error:', err);
        res.status(500).json({ error: 'Failed to fetch projects.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { name, guild, tagline, description, coverImageUrl, devlogMode, reviewType, linkedDesignProjectId, repoUrl } = req.body;
        // Duplicate creation guard: prevent double-clicks/retries within 5 seconds
        const duplicateCheck = await query(
            `SELECT id FROM projects
             WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '5 seconds'
             LIMIT 1`,
            [req.user.id, name.trim()]
        );
        if (duplicateCheck.rows.length > 0) {
            const existingProject = await getProjectWithEntries(duplicateCheck.rows[0].id, req.user.id);
            return res.json(existingProject);
        }

        // Generate slug-style ID, ensure uniqueness
        const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `project-${Date.now()}`;
        let id = baseId;
        let counter = 1;
        while (true) {
            const check = await query('SELECT id FROM projects WHERE id = $1', [id]);
            if (check.rows.length === 0) break;
            id = `${baseId}-${counter++}`;
        }

        const result = await query(
            `INSERT INTO projects
                (id, user_id, name, guild, tagline, description, cover_image_url, review_type, linked_design_project_id, repo_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                id,
                req.user.id,
                name.trim(),
                guild || 'frontier',
                tagline?.trim() || '',
                description?.trim() || '',
                coverImageUrl || 'jet.png',
                reviewType || 'design',
                linkedDesignProjectId || null,
                repoUrl || null,
            ]
        );

        // Fetch with user info
        const project = await getProjectWithEntries(result.rows[0].id, req.user.id);
        res.status(201).json(project);
    } catch (err) {
        console.error('[Projects] POST / error:', err);
        res.status(500).json({ error: 'Failed to create project.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const project = await getProjectWithEntries(req.params.id, req.user.id);
        if (!project) return res.status(404).json({ error: 'Project not found.' });
        res.json(project);
    } catch (err) {
        console.error('[Projects] GET /:id error:', err);
        res.status(500).json({ error: 'Failed to fetch project.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/projects/:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
    try {
        const { name, tagline, description, coverImageUrl, guild, devlogMode, repoUrl } = req.body;

        // Build dynamic SET clause
        const fields = [];
        const vals = [];
        let idx = 1;
        if (name !== undefined)          { fields.push(`name = $${idx++}`);             vals.push(name.trim()); }
        if (tagline !== undefined)        { fields.push(`tagline = $${idx++}`);           vals.push(tagline.trim()); }
        if (description !== undefined)    { fields.push(`description = $${idx++}`);       vals.push(description.trim()); }
        if (coverImageUrl !== undefined)  { fields.push(`cover_image_url = $${idx++}`);   vals.push(coverImageUrl); }
        if (guild !== undefined)          { fields.push(`guild = $${idx++}`);             vals.push(guild); }
        if (repoUrl !== undefined)        { fields.push(`repo_url = $${idx++}`);          vals.push(repoUrl); }

        if (fields.length === 0) return res.status(400).json({ error: 'No fields to update.' });

        vals.push(req.params.id, req.user.id);
        const result = await query(
            `UPDATE projects SET ${fields.join(', ')}
             WHERE id = $${idx++} AND user_id = $${idx++} AND deleted_at IS NULL
             RETURNING *`,
            vals
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found.' });

        const project = await getProjectWithEntries(req.params.id, req.user.id);
        res.json(project);
    } catch (err) {
        console.error('[Projects] PATCH /:id error:', err);
        res.status(500).json({ error: 'Failed to update project.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/projects/:id  (soft delete — data preserved forever)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const result = await query(
            `UPDATE projects SET deleted_at = NOW()
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [req.params.id, req.user.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found.' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Projects] DELETE /:id error:', err);
        res.status(500).json({ error: 'Failed to delete project.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:id/submit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/submit', async (req, res) => {
    try {
        // Check there is at least 1 journal entry
        const entriesRes = await query(
            `SELECT COUNT(*) FROM journal_entries
             WHERE project_id = $1 AND deleted_at IS NULL`,
            [req.params.id]
        );
        if (parseInt(entriesRes.rows[0].count) === 0) {
            return res.status(400).json({ error: 'You must have at least one journal entry before submitting.' });
        }

        const result = await query(
            `UPDATE projects
             SET status = 'submitted',
                 submitted_at = NOW(),
                 review_feedback = 'Your project is currently in the reviewer queue. A reviewer will check your photos, CAD models, and hours soon!'
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [req.params.id, req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found.' });

        const project = await getProjectWithEntries(req.params.id, req.user.id);
        res.json(project);
    } catch (err) {
        console.error('[Projects] POST /:id/submit error:', err);
        res.status(500).json({ error: 'Failed to submit project.' });
    }
});

export default router;
