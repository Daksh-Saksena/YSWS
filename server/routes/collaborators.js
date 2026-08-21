/**
 * Trek YSWS — Collaborators API Routes
 *
 * Handles:
 *  - Listing team members / collaborators for a project
 *  - Inviting collaborators by Slack ID or Email
 *  - Removing collaborators
 */

import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

async function checkProjectAdmin(projectId, userId) {
    // Owner or co-owner
    const pRes = await query(
        `SELECT p.user_id FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId]
    );
    if (pRes.rows.length === 0) return false;
    if (pRes.rows[0].user_id === userId) return true;

    const cRes = await query(
        `SELECT role FROM project_collaborators WHERE project_id = $1 AND user_id = $2 AND role = 'co_owner' AND status = 'active'`,
        [projectId, userId]
    );
    return cRes.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects/:projectId/collaborators
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const { projectId } = req.params;
    try {
        const result = await query(
            `SELECT c.id, c.project_id, c.user_id, c.slack_id, c.email, c.role, c.status, c.created_at,
                    u.display_name, u.avatar_url
             FROM project_collaborators c
             LEFT JOIN users u ON u.id = c.user_id
             WHERE c.project_id = $1
             ORDER BY c.created_at ASC`,
            [projectId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('[Collaborators] GET error:', err);
        res.status(500).json({ error: 'Failed to fetch collaborators.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects/:projectId/collaborators
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { projectId } = req.params;
    const { identifier, role } = req.body; // identifier can be Slack ID (e.g. U0123) or Email

    if (!identifier?.trim()) {
        return res.status(400).json({ error: 'Please provide a Slack ID or Email address.' });
    }

    try {
        const isAdmin = await checkProjectAdmin(projectId, req.user.id);
        if (!isAdmin) {
            return res.status(403).json({ error: 'Only the project owner can invite collaborators.' });
        }

        const cleanInput = identifier.trim().replace(/^@/, '');
        const isEmail = cleanInput.includes('@') && cleanInput.includes('.');
        const colRole = role === 'co_owner' ? 'co_owner' : 'collaborator';

        // 1. Check if user already exists in Trek
        let targetUser = null;
        if (isEmail) {
            const uRes = await query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [cleanInput]);
            if (uRes.rows.length > 0) targetUser = uRes.rows[0];
        } else {
            const uRes = await query(`SELECT * FROM users WHERE UPPER(slack_id) = UPPER($1) OR LOWER(display_name) = LOWER($1) LIMIT 1`, [cleanInput]);
            if (uRes.rows.length > 0) targetUser = uRes.rows[0];
        }

        // Prevent inviting the owner
        const pOwnerRes = await query(`SELECT user_id FROM projects WHERE id = $1`, [projectId]);
        if (targetUser && pOwnerRes.rows.length > 0 && pOwnerRes.rows[0].user_id === targetUser.id) {
            return res.status(400).json({ error: 'You are already the owner of this project.' });
        }

        // 2. Check if already invited / collaborator
        let existingCollab;
        if (targetUser) {
            existingCollab = await query(
                `SELECT id FROM project_collaborators WHERE project_id = $1 AND user_id = $2`,
                [projectId, targetUser.id]
            );
        } else if (isEmail) {
            existingCollab = await query(
                `SELECT id FROM project_collaborators WHERE project_id = $1 AND LOWER(email) = LOWER($2)`,
                [projectId, cleanInput]
            );
        } else {
            existingCollab = await query(
                `SELECT id FROM project_collaborators WHERE project_id = $1 AND UPPER(slack_id) = UPPER($2)`,
                [projectId, cleanInput]
            );
        }

        if (existingCollab.rows.length > 0) {
            return res.status(400).json({ error: 'This person is already a collaborator or has an invite.' });
        }

        // 3. Insert collaborator record
        const insertRes = await query(
            `INSERT INTO project_collaborators
                (project_id, user_id, invited_by, slack_id, email, role, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                projectId,
                targetUser ? targetUser.id : null,
                req.user.id,
                targetUser ? targetUser.slack_id : (isEmail ? null : cleanInput),
                targetUser ? targetUser.email : (isEmail ? cleanInput : null),
                colRole,
                targetUser ? 'active' : 'invited',
            ]
        );

        const newCollab = insertRes.rows[0];
        if (targetUser) {
            newCollab.display_name = targetUser.display_name;
            newCollab.avatar_url = targetUser.avatar_url;
        } else {
            newCollab.display_name = isEmail ? cleanInput : `@${cleanInput}`;
            newCollab.avatar_url = null;
        }

        res.status(201).json(newCollab);
    } catch (err) {
        console.error('[Collaborators] POST error:', err);
        res.status(500).json({ error: 'Failed to invite collaborator.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/projects/:projectId/collaborators/:collabId
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:collabId', async (req, res) => {
    const { projectId, collabId } = req.params;
    try {
        const isAdmin = await checkProjectAdmin(projectId, req.user.id);
        const collabRes = await query(
            `SELECT user_id FROM project_collaborators WHERE id = $1 AND project_id = $2`,
            [collabId, projectId]
        );

        if (collabRes.rows.length === 0) {
            return res.status(404).json({ error: 'Collaborator not found.' });
        }

        const isSelf = collabRes.rows[0].user_id === req.user.id;
        if (!isAdmin && !isSelf) {
            return res.status(403).json({ error: 'You do not have permission to remove this collaborator.' });
        }

        await query(
            `DELETE FROM project_collaborators WHERE id = $1 AND project_id = $2`,
            [collabId, projectId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[Collaborators] DELETE error:', err);
        res.status(500).json({ error: 'Failed to remove collaborator.' });
    }
});

export default router;
