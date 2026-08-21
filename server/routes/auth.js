/**
 * Trek YSWS — Hack Club Slack OAuth Routes
 *
 * Flow:
 *   1. GET /auth/login  → redirects browser to Slack authorization page
 *   2. Slack calls GET /auth/callback?code=xxx
 *   3. Server exchanges code for Slack access token
 *   4. Server fetches user identity from Slack
 *   5. Upsert user into DB
 *   6. Sign a JWT and send it back to the frontend via redirect
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = Router();

const DEFAULT_SLACK_CLIENT_ID = '2210535565.11871399547573';
const DEFAULT_SLACK_CLIENT_SECRET = 'b059068691f6d9123ffd121627900d7b';

function getAuthContext(req) {
    const clientId = process.env.SLACK_CLIENT_ID || DEFAULT_SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET || DEFAULT_SLACK_CLIENT_SECRET;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'ysws-sigma.vercel.app';
    const origin = `${protocol}://${host}`;
    const serverUrl = process.env.SERVER_URL || origin;
    const frontendUrl = process.env.FRONTEND_URL || origin;
    const redirectUri = `${serverUrl}/auth/callback`;
    const jwtSecret = process.env.JWT_SECRET || 'trek_ysws_jwt_secret_fallback_key_2024';

    return { clientId, clientSecret, serverUrl, frontendUrl, redirectUri, jwtSecret };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/login
// Redirects the user to Hack Club Slack to authorize Trek
// ─────────────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
    const { clientId, redirectUri } = getAuthContext(req);
    const params = new URLSearchParams({
        client_id: clientId,
        user_scope: 'identity.basic,identity.avatar,identity.email,openid,profile,email',
        redirect_uri: redirectUri,
    });
    res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/callback
// Slack redirects here with ?code=xxx after the user authorizes
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    const { clientId, clientSecret, frontendUrl, redirectUri, jwtSecret } = getAuthContext(req);

    if (error || !code) {
        console.error('[Auth] Slack returned error in callback:', error);
        return res.redirect(`${frontendUrl}/login.html?error=${encodeURIComponent(error || 'slack_denied')}`);
    }

    try {
        // 1. Exchange code for access token
        const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
            }),
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.ok) {
            console.error('[Auth] Slack token exchange failed:', tokenData.error);
            return res.redirect(`${frontendUrl}/login.html?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`);
        }

        // 2. Fetch user identity using the authed_user.access_token
        const userToken = tokenData.authed_user?.access_token || tokenData.access_token;
        let slackId = tokenData.authed_user?.id;
        let displayName = 'Trek Builder';
        let avatarUrl = null;
        let email = null;

        if (userToken) {
            // Try users.identity first
            const identityRes = await fetch('https://slack.com/api/users.identity', {
                headers: { Authorization: `Bearer ${userToken}` },
            });
            const identity = await identityRes.json();

            if (identity.ok && identity.user) {
                slackId = identity.user.id || slackId;
                displayName = identity.user.name || displayName;
                avatarUrl = identity.user.image_192 || identity.user.image_72 || null;
                email = identity.user.email || null;
            } else {
                // Try openid.connect.userInfo if identity wasn't enabled
                const oidcRes = await fetch('https://slack.com/api/openid.connect.userInfo', {
                    headers: { Authorization: `Bearer ${userToken}` },
                });
                const oidcData = await oidcRes.json();
                if (oidcData.ok) {
                    slackId = oidcData['https://slack.com/user_id'] || oidcData.sub || slackId;
                    displayName = oidcData.name || displayName;
                    avatarUrl = oidcData.picture || null;
                    email = oidcData.email || null;
                }
            }
        }

        if (!slackId) {
            return res.redirect(`${frontendUrl}/login.html?error=could_not_read_user_id`);
        }

        // 3. Upsert user in DB
        const upsertResult = await query(
            `INSERT INTO users (slack_id, display_name, avatar_url, email)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (slack_id) DO UPDATE
               SET display_name = EXCLUDED.display_name,
                   avatar_url   = EXCLUDED.avatar_url,
                   email        = EXCLUDED.email,
                   updated_at   = NOW()
             RETURNING id, slack_id, display_name, avatar_url`,
            [slackId, displayName, avatarUrl, email]
        );

        const user = upsertResult.rows[0];

        // 3b. Auto-link pending collaborator invitations matching Slack ID or Email
        try {
            await query(
                `UPDATE project_collaborators
                 SET user_id = $1, status = 'active', updated_at = NOW()
                 WHERE user_id IS NULL AND (
                     UPPER(slack_id) = UPPER($2) OR (email IS NOT NULL AND LOWER(email) = LOWER($3))
                 )`,
                [user.id, slackId, email || '']
            );
        } catch (e) {
            console.warn('[Auth] Error linking pending collaborator invites:', e.message);
        }

        // 4. Issue a JWT (expires in 365 days)
        const token = jwt.sign(
            {
                id: user.id,
                slack_id: user.slack_id,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
            },
            jwtSecret,
            { expiresIn: '365d' }
        );

        // 5. Send JWT back to frontend via URL (frontend stores it)
        res.redirect(`${frontendUrl}/login.html?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify({ id: user.id, display_name: user.display_name, avatar_url: user.avatar_url }))}`);
    } catch (err) {
        console.error('[Auth] OAuth callback error:', err);
        res.redirect(`${frontendUrl}/login.html?error=server_error`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/dev-login (Instant local dev testing without Slack app setup)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dev-login', async (req, res) => {
    try {
        const slackId = 'U_TREK_DEV_BUILDER';
        const displayName = 'Trek Builder (Dev)';
        const avatarUrl = 'images/flag.png';
        const email = 'builder@hackclub.com';

        const upsertResult = await query(
            `INSERT INTO users (slack_id, display_name, avatar_url, email)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (slack_id) DO UPDATE
               SET display_name = EXCLUDED.display_name,
                   avatar_url   = EXCLUDED.avatar_url,
                   updated_at   = NOW()
             RETURNING id, slack_id, display_name, avatar_url`,
            [slackId, displayName, avatarUrl, email]
        );

        const user = upsertResult.rows[0];

        const token = jwt.sign(
            {
                id: user.id,
                slack_id: user.slack_id,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
            },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.redirect(`${FRONTEND_URL}/login.html?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify({ id: user.id, display_name: user.display_name, avatar_url: user.avatar_url }))}`);
    } catch (err) {
        console.error('[Auth] Dev login error:', err);
        res.redirect(`${FRONTEND_URL}/login.html?error=dev_login_failed`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me
// Returns current user info from the JWT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
    }
    try {
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
        res.json({ user: payload });
    } catch {
        res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
});

export default router;
