/**
 * Trek YSWS — Hack Club Auth Routes
 *
 * Flow:
 *   1. GET /auth/login  → redirects browser to Hack Club Auth authorization page
 *   2. HC Auth calls GET /auth/callback?code=xxx
 *   3. Server exchanges code for HC Auth access token
 *   4. Server fetches user identity from HC Auth
 *   5. Upsert user into DB
 *   6. Sign a JWT and send it back to the frontend via redirect
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = Router();

function getAuthContext(req) {
    const clientId = (process.env.HC_AUTH_CLIENT_ID || '').trim();
    const clientSecret = (process.env.HC_AUTH_CLIENT_SECRET || '').trim();

    if (!clientId || !clientSecret) {
        console.error('[Auth] ERROR: Environment variables HC_AUTH_CLIENT_ID or HC_AUTH_CLIENT_SECRET are missing in this Vercel deployment!');
    }

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
// Redirects the user to Hack Club Auth to authorize Trek
// ─────────────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
    const { clientId, redirectUri } = getAuthContext(req);
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'slack_id name profile email'
    });
    res.redirect(`https://auth.hackclub.com/oauth/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/callback
// HC Auth redirects here with ?code=xxx after the user authorizes
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    const { clientId, clientSecret, frontendUrl, redirectUri, jwtSecret } = getAuthContext(req);

    if (error || !code) {
        console.error('[Auth] HC Auth returned error in callback:', error);
        return res.redirect(`${frontendUrl}/login.html?error=${encodeURIComponent(error || 'hc_auth_denied')}`);
    }

    try {
        // 1. Exchange code for access token
        const tokenRes = await fetch('https://auth.hackclub.com/oauth/token', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
            }).toString(),
        });
        const tokenData = await tokenRes.json();

        if (tokenData.error || !tokenData.access_token) {
            console.error('[Auth] HC Auth token exchange failed:', tokenData.error || tokenData);
            return res.redirect(`${frontendUrl}/login.html?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`);
        }

        const userToken = tokenData.access_token;

        // 2. Fetch user identity using the access_token
        const identityRes = await fetch('https://auth.hackclub.com/api/v1/me', {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const identityData = await identityRes.json();

        if (!identityRes.ok || !identityData) {
             console.error('[Auth] HC Auth user info fetch failed:', identityData);
             return res.redirect(`${frontendUrl}/login.html?error=could_not_read_user`);
        }
        console.log('[Auth] HC Auth identity payload:', JSON.stringify(identityData, null, 2));

        const userObj = identityData.identity || identityData.user || identityData;

        let slackId = userObj.slack_id || userObj.slackId;
        if (!slackId) {
            if (userObj.id) {
                slackId = `hc_${userObj.id}`;
                console.warn(`[Auth] No Slack ID provided by HC Auth. Falling back to HC Auth ID: ${slackId}`);
            } else if (userObj.email || userObj.primary_email) {
                slackId = `hc_email_${userObj.email || userObj.primary_email}`;
                console.warn(`[Auth] No Slack ID or HC Auth ID provided. Falling back to email: ${slackId}`);
            } else {
                console.error('[Auth] NO STABLE IDENTIFIER PROVIDED BY HC AUTH!', identityData);
                const debugStr = encodeURIComponent(JSON.stringify(identityData));
                return res.redirect(`${frontendUrl}/login.html?error=no_slack_id&details=${debugStr}`);
            }
        }

        let displayName = 'Trek Builder';
        if (userObj.first_name || userObj.last_name) {
            displayName = `${userObj.first_name || ''} ${userObj.last_name || ''}`.trim();
        } else if (userObj.name) {
            displayName = userObj.name;
        }

        const avatarUrl = userObj.avatar || userObj.avatar_url || null;
        const email = userObj.primary_email || userObj.email || null;

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
// GET /auth/dev-login (Instant local dev testing without Auth app setup)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dev-login', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Dev login is disabled in production.' });
    }
    
    try {
        const { frontendUrl, jwtSecret } = getAuthContext(req);
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
            jwtSecret,
            { expiresIn: '30d' }
        );

        res.redirect(`${frontendUrl}/login.html?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify({ id: user.id, display_name: user.display_name, avatar_url: user.avatar_url }))}`);
    } catch (err) {
        console.error('[Auth] Dev login error:', err);
        const { frontendUrl } = getAuthContext(req);
        res.redirect(`${frontendUrl}/login.html?error=dev_login_failed`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me
// Returns current user info from the JWT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
    const { jwtSecret } = getAuthContext(req);
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
    }
    try {
        const payload = jwt.verify(authHeader.slice(7), jwtSecret);
        res.json({ user: payload });
    } catch {
        res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
});

export default router;
