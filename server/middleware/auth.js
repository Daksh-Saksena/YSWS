/**
 * Trek YSWS — JWT Authentication Middleware
 *
 * Verifies the Bearer token on every protected route.
 * Attaches req.user = { id, slack_id, display_name, avatar_url }
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'trek_ysws_jwt_secret_fallback_key_2024';

export function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    }

    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token expired or invalid. Please log in again.' });
    }
}

/**
 * Optional auth — attaches req.user if token is valid, but doesn't block
 * the request if no token is provided.
 */
export function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            req.user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        } catch (_) {
            // silently ignore invalid token for optional routes
        }
    }
    next();
}
