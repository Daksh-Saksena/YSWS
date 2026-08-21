/**
 * Trek YSWS — Auth State Management
 *
 * Handles:
 *  - Reading the JWT token from the login redirect URL
 *  - Storing/clearing the token and user in localStorage
 *  - Redirecting unauthenticated users to login.html
 *  - Exposing the current user for header rendering
 */

import { api } from './api.js';

const TREK_TOKEN_KEY = 'trek_jwt_token';
const TREK_USER_KEY  = 'trek_current_user';

/**
 * Call on every page that requires auth.
 * If no token is present, redirects to login.html.
 * Returns the current user object.
 */
export function requireLogin() {
    if (!api.isLoggedIn()) {
        window.location.href = 'login.html';
        return null;
    }
    return api.getCurrentUser();
}

/**
 * Call on login.html after Slack OAuth redirect.
 * Parses ?token=...&user=... from the URL and stores them.
 * Then redirects to projects.html.
 */
export function handleLoginCallback() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const userJson = params.get('user');
    const error = params.get('error');

    if (error) {
        const el = document.getElementById('login-error');
        if (el) el.textContent = `Login failed: ${error}. Please try again.`;
        return;
    }

    if (token && userJson) {
        try {
            const user = JSON.parse(decodeURIComponent(userJson));
            api.setToken(token);
            api.setCurrentUser(user);
            // Redirect to dashboard
            window.location.href = 'projects.html';
        } catch (e) {
            console.error('[Auth] Failed to parse user data from login:', e);
        }
    }
}

/**
 * Renders the user's name and avatar in a nav element.
 * Expects an element with id="nav-user-info" to exist.
 */
export function renderNavUser() {
    const user = api.getCurrentUser();
    const container = document.getElementById('nav-user-info');
    if (!container || !user) return;

    container.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
            ${user.avatar_url ? `<img src="${user.avatar_url}" alt="${user.display_name}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">` : ''}
            <span style="font-size:0.9rem;color:var(--hc-smoke);">${user.display_name || 'Builder'}</span>
            <button onclick="trekLogout()" style="background:none;border:1px solid rgba(255,255,255,0.15);color:var(--hc-muted);font-size:0.8rem;padding:4px 10px;border-radius:5px;cursor:pointer;">Logout</button>
        </div>
    `;
}

window.trekLogout = function () {
    api.logout();
    window.location.href = 'login.html';
};
