/**
 * Trek YSWS — API & Service Layer (v3 — PostgreSQL backend)
 *
 * This replaces the old localStorage-only implementation.
 *
 * SAFETY LAYERS implemented in the frontend:
 *   Layer 3  — Auto-save heartbeat: any open journal draft is saved every 30s
 *   Layer 4  — localStorage mirror: every successful write is also mirrored to
 *               localStorage so users can read their data even if the server
 *               is temporarily unreachable
 *   Layer 10 — Offline queue: writes attempted while offline are queued and
 *               automatically retried when the connection is restored
 *
 * Authentication:
 *   The JWT token from Hack Club Slack login is stored in localStorage under
 *   TREK_TOKEN_KEY. All API calls send it as "Authorization: Bearer <token>".
 */

import { TrekTimeParser } from './timeParser.js';
import { TrekJournalValidator } from './journalValidator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

// Auto-detect localhost vs production deployment (Vercel serverless)
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const API_BASE = window.TREK_API_BASE || (isLocal ? 'http://localhost:3001' : '');

const STORAGE_KEY      = 'trek_ysws_projects_db_v2';   // legacy + mirror
const ASSETS_STORAGE_KEY = 'trek_ysws_assets_db_v1';
const TREK_TOKEN_KEY   = 'trek_jwt_token';
const TREK_USER_KEY    = 'trek_current_user';
const OFFLINE_QUEUE_KEY = 'trek_offline_queue';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ls(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
}
function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

export class TrekApiService {
    constructor() {
        // In-memory fallback (used if localStorage is also broken)
        this.memoryStorage = null;
        this.memoryAssets  = {};
        this._offlineQueue = ls(OFFLINE_QUEUE_KEY, []);
        this._flushingQueue = false;

        // Listen for network recovery → flush offline queue
        window.addEventListener('online', () => this._flushOfflineQueue());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Auth helpers
    // ─────────────────────────────────────────────────────────────────────────

    getToken() {
        return localStorage.getItem(TREK_TOKEN_KEY) || null;
    }

    setToken(token) {
        localStorage.setItem(TREK_TOKEN_KEY, token);
    }

    getCurrentUser() {
        return ls(TREK_USER_KEY, null);
    }

    setCurrentUser(user) {
        lsSet(TREK_USER_KEY, user);
    }

    isLoggedIn() {
        return !!this.getToken();
    }

    logout() {
        localStorage.removeItem(TREK_TOKEN_KEY);
        localStorage.removeItem(TREK_USER_KEY);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core fetch wrapper
    // ─────────────────────────────────────────────────────────────────────────

    async _fetch(path, options = {}) {
        const token = this.getToken();
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {}),
        };

        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (res.status === 401) {
                this.logout();
            }
            throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.json();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Safety Layer 4: localStorage mirror helpers
    // ─────────────────────────────────────────────────────────────────────────

    _mirrorProjects(projects) {
        lsSet(STORAGE_KEY, projects);
    }

    _getMirroredProjects() {
        return ls(STORAGE_KEY, []);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Safety Layer 10: Offline queue
    // ─────────────────────────────────────────────────────────────────────────

    _enqueueOffline(operation, args) {
        this._offlineQueue.push({ operation, args, ts: Date.now() });
        lsSet(OFFLINE_QUEUE_KEY, this._offlineQueue);
        console.warn(`[Trek] Offline — queued operation: ${operation}`);
    }

    async _flushOfflineQueue() {
        if (this._flushingQueue || this._offlineQueue.length === 0) return;
        this._flushingQueue = true;
        console.log(`[Trek] Back online — flushing ${this._offlineQueue.length} queued operations...`);

        const toProcess = [...this._offlineQueue];
        this._offlineQueue = [];
        lsSet(OFFLINE_QUEUE_KEY, []);

        for (const item of toProcess) {
            try {
                await this[item.operation](...item.args);
                console.log(`[Trek] Flushed: ${item.operation}`);
            } catch (err) {
                console.error(`[Trek] Failed to flush ${item.operation}:`, err);
                // Re-queue permanently-failed items
                this._offlineQueue.push(item);
            }
        }
        lsSet(OFFLINE_QUEUE_KEY, this._offlineQueue);
        this._flushingQueue = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Asset URL resolution (images stored in Cloudinary, keyed by short URL)
    // ─────────────────────────────────────────────────────────────────────────

    resolveAssetUrl(url) {
        if (!url) return '';
        
        // Handle legacy hardcoded paths in the DB before the asset reorganization
        if (url === 'jet.png') url = 'images/jet.png';
        if (url === 'flag.png') url = 'images/flag.png';

        // Check localStorage mirror first
        try {
            const assets = ls(ASSETS_STORAGE_KEY, {});
            return assets[url] || url;
        } catch { return url; }
    }

    getDefaultCover(guild) {
        const g = (guild || '').toLowerCase();
        if (g === 'air') return 'images/jet.png';
        if (g === 'land') return 'images/red_car.png';
        if (g === 'water') return 'images/boat.png';
        if (g === 'space' || g === 'frontier') return 'images/rocket.png';
        return 'images/rocket.png';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PROJECT OPERATIONS
    // ─────────────────────────────────────────────────────────────────────────

    async getProjects() {
        try {
            const projects = await this._fetch('/api/projects');
            this._mirrorProjects(projects);    // Safety Layer 4
            return projects;
        } catch (err) {
            if (!navigator.onLine || err.status >= 500) {
                console.warn('[Trek] Offline/server error — reading from localStorage mirror');
                return this._getMirroredProjects();
            }
            throw err;
        }
    }

    async getExploreData() {
        try {
            return await this._fetch('/api/explore');
        } catch (err) {
            console.error('[Trek] Failed to fetch explore data:', err);
            return { projects: [], leaderboard: [] };
        }
    }

    async getProject(projectId) {
        try {
            const project = await this._fetch(`/api/projects/${projectId}`);
            if (project && project.assets) {
                const currentAssets = ls(ASSETS_STORAGE_KEY, {});
                Object.assign(currentAssets, project.assets);
                lsSet(ASSETS_STORAGE_KEY, currentAssets);
            }
            // Update mirror
            const mirror = this._getMirroredProjects();
            const idx = mirror.findIndex(p => p.id === projectId);
            if (idx >= 0) mirror[idx] = project; else mirror.unshift(project);
            this._mirrorProjects(mirror);
            return project;
        } catch (err) {
            if (!navigator.onLine || err.status >= 500) {
                return this._getMirroredProjects().find(p => p.id === projectId) || null;
            }
            throw err;
        }
    }

    async createProject(projectData) {
        const body = {
            name: projectData.name,
            guild: projectData.guild || 'frontier',
            tagline: projectData.tagline || '',
            description: projectData.description || '',
            coverImageUrl: projectData.coverImageUrl || this.getDefaultCover(projectData.guild),
            reviewType: projectData.reviewType || 'design',
            linkedDesignProjectId: projectData.linkedDesignProjectId || null,
            repoUrl: projectData.repoUrl || null,
        };

        if (!navigator.onLine) {
            this._enqueueOffline('createProject', [projectData]);
            // Return optimistic local object so UI works immediately
            const tempProject = { ...body, id: `temp-${Date.now()}`, status: 'draft', journalEntries: [], totalHours: 0, version: 1, createdAt: new Date().toISOString() };
            const mirror = this._getMirroredProjects();
            mirror.unshift(tempProject);
            this._mirrorProjects(mirror);
            return tempProject;
        }

        const project = await this._fetch('/api/projects', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const mirror = this._getMirroredProjects();
        mirror.unshift(project);
        this._mirrorProjects(mirror);
        return project;
    }

    async updateProject(projectId, updateData) {
        const body = {};
        if (updateData.name !== undefined)         body.name = updateData.name;
        if (updateData.tagline !== undefined)       body.tagline = updateData.tagline;
        if (updateData.description !== undefined)   body.description = updateData.description;
        if (updateData.coverImageUrl !== undefined) body.coverImageUrl = updateData.coverImageUrl;
        if (updateData.guild !== undefined)         body.guild = updateData.guild;
        if (updateData.repoUrl !== undefined)       body.repoUrl = updateData.repoUrl;

        if (!navigator.onLine) {
            this._enqueueOffline('updateProject', [projectId, updateData]);
            // Optimistic local update
            const mirror = this._getMirroredProjects();
            const idx = mirror.findIndex(p => p.id === projectId);
            if (idx >= 0) { mirror[idx] = { ...mirror[idx], ...body }; this._mirrorProjects(mirror); return mirror[idx]; }
        }

        const project = await this._fetch(`/api/projects/${projectId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        });
        const mirror = this._getMirroredProjects();
        const idx = mirror.findIndex(p => p.id === projectId);
        if (idx >= 0) mirror[idx] = project; else mirror.unshift(project);
        this._mirrorProjects(mirror);
        return project;
    }

    async deleteProject(projectId) {
        if (!navigator.onLine) {
            this._enqueueOffline('deleteProject', [projectId]);
            const mirror = this._getMirroredProjects().filter(p => p.id !== projectId);
            this._mirrorProjects(mirror);
            return true;
        }
        await this._fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
        const mirror = this._getMirroredProjects().filter(p => p.id !== projectId);
        this._mirrorProjects(mirror);
        return true;
    }

    async submitProjectForReview(projectId) {
        const mirror = this._getMirroredProjects();
        const project = mirror.find(p => p.id === projectId);
        if (project && project.journalEntries.length === 0) {
            throw new Error('You must have at least one journal entry before submitting for review.');
        }

        const updated = await this._fetch(`/api/projects/${projectId}/submit`, { method: 'POST' });
        const idx = mirror.findIndex(p => p.id === projectId);
        if (idx >= 0) mirror[idx] = updated; else mirror.unshift(updated);
        this._mirrorProjects(mirror);
        return updated;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLLABORATOR OPERATIONS
    // ─────────────────────────────────────────────────────────────────────────

    async getCollaborators(projectId) {
        return await this._fetch(`/api/projects/${projectId}/collaborators`);
    }

    async inviteCollaborator(projectId, identifier, role = 'collaborator') {
        const collab = await this._fetch(`/api/projects/${projectId}/collaborators`, {
            method: 'POST',
            body: JSON.stringify({ identifier, role }),
        });
        return collab;
    }

    async removeCollaborator(projectId, collaboratorId) {
        return await this._fetch(`/api/projects/${projectId}/collaborators/${collaboratorId}`, {
            method: 'DELETE',
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // JOURNAL ENTRY OPERATIONS
    // ─────────────────────────────────────────────────────────────────────────

    async createJournalEntry(projectId, entryData) {
        const parsedHours = TrekTimeParser.parse(entryData.timeSpent) || 0;
        const body = {
            title: entryData.title,
            content: entryData.content,
            date: entryData.date || new Date().toISOString().split('T')[0],
            timeSpent: entryData.timeSpent || '1 hr',
            timeHours: parsedHours,
            milestone: entryData.milestone || 'general',
            images: entryData.images || [],
            tags: entryData.tags || [],
            lapseUrl: entryData.lapseUrl || null,
        };

        if (!navigator.onLine) {
            this._enqueueOffline('createJournalEntry', [projectId, entryData]);
            const tempEntry = { ...body, id: `entry-temp-${Date.now()}`, projectId, status: 'published', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            // Optimistic local update
            const mirror = this._getMirroredProjects();
            const proj = mirror.find(p => p.id === projectId);
            if (proj) { proj.journalEntries.unshift(tempEntry); proj.totalHours = this._computeTotalHours(proj.journalEntries); this._mirrorProjects(mirror); }
            return { entry: tempEntry, project: proj };
        }

        const entry = await this._fetch(`/api/journals/${projectId}`, {
            method: 'POST',
            body: JSON.stringify(body),
        });

        // Refetch project to get updated totals
        const project = await this.getProject(projectId);
        return { entry, project };
    }

    async updateJournalEntry(projectId, entryId, entryData) {
        const parsedHours = TrekTimeParser.parse(entryData.timeSpent) || 0;
        const body = {
            title: entryData.title,
            content: entryData.content,
            date: entryData.date,
            timeSpent: entryData.timeSpent,
            timeHours: parsedHours,
            milestone: entryData.milestone,
            images: entryData.images,
            tags: entryData.tags,
            lapseUrl: entryData.lapseUrl,
        };

        if (!navigator.onLine) {
            this._enqueueOffline('updateJournalEntry', [projectId, entryId, entryData]);
            const mirror = this._getMirroredProjects();
            const proj = mirror.find(p => p.id === projectId);
            if (proj) {
                const idx = proj.journalEntries.findIndex(e => e.id === entryId);
                if (idx >= 0) { proj.journalEntries[idx] = { ...proj.journalEntries[idx], ...body, updatedAt: new Date().toISOString() }; this._mirrorProjects(mirror); }
            }
            return { entry: proj?.journalEntries.find(e => e.id === entryId), project: proj };
        }

        const entry = await this._fetch(`/api/journals/${projectId}/${entryId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        });
        const project = await this.getProject(projectId);
        return { entry, project };
    }

    async deleteJournalEntry(projectId, entryId) {
        if (!navigator.onLine) {
            this._enqueueOffline('deleteJournalEntry', [projectId, entryId]);
            const mirror = this._getMirroredProjects();
            const proj = mirror.find(p => p.id === projectId);
            if (proj) { proj.journalEntries = proj.journalEntries.filter(e => e.id !== entryId); proj.totalHours = this._computeTotalHours(proj.journalEntries); this._mirrorProjects(mirror); }
            return proj;
        }

        await this._fetch(`/api/journals/${projectId}/${entryId}`, { method: 'DELETE' });
        const project = await this.getProject(projectId);
        return project;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMAGE UPLOADS — via Cloudinary through our backend
    // ─────────────────────────────────────────────────────────────────────────

    async uploadEvidence(file, projectId = null) {
        return new Promise((resolve) => {
            if (!file.type.startsWith('image/')) {
                return resolve({
                    url: '',
                    markdown: '![Unsupported file type - please upload an image]()'
                });
            }

            // Client-side image compression
            const compressImage = (file, maxWidth = 1920, maxHeight = 1920, quality = 0.75) => {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const img = new Image();
                        img.onload = () => {
                            let width = img.width;
                            let height = img.height;

                            if (width > height) {
                                if (width > maxWidth) {
                                    height = Math.round(height * maxWidth / width);
                                    width = maxWidth;
                                }
                            } else {
                                if (height > maxHeight) {
                                    width = Math.round(width * maxHeight / height);
                                    height = maxHeight;
                                }
                            }

                            const canvas = document.createElement('canvas');
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);
                            
                            // Output as JPEG for high compression
                            const dataUrl = canvas.toDataURL('image/jpeg', quality);
                            resolve(dataUrl);
                        };
                        img.onerror = reject;
                        img.src = event.target.result;
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            };

            compressImage(file).then(dataUrl => {
                const ext = 'jpg';
                const randomHash = Math.random().toString(36).substring(2, 8);
                const timeStamp = Date.now().toString(36);
                const shortUrl = `https://cdn.hackclub.com/trek/${timeStamp}_${randomHash}.${ext}`;
                const safeName = file.name ? file.name.replace(/[^\w.-]+/g, '_') : `image_${randomHash}.jpg`;

                const fallbackLocal = () => {
                    const assets = ls(ASSETS_STORAGE_KEY, {});
                    assets[shortUrl] = dataUrl;
                    lsSet(ASSETS_STORAGE_KEY, assets);
                    resolve({ url: shortUrl, markdown: `![${safeName}](${shortUrl})` });
                };

                if (!navigator.onLine) {
                    return fallbackLocal();
                }

                // Online: Send as base64 JSON
                const token = this.getToken();
                fetch(`${API_BASE}/api/uploads`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(token ? { Authorization: `Bearer ${token}` } : {})
                    },
                    body: JSON.stringify({ file: dataUrl, projectId, originalname: safeName }),
                })
                    .then(async r => {
                        const text = await r.text();
                        let data;
                        try {
                            data = JSON.parse(text);
                        } catch(e) {
                            throw new Error(`HTTP ${r.status}: ${text.substring(0, 40).replace(/\\n/g, ' ')}...`);
                        }
                        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                        return data;
                    })
                    .then(data => {
                        if (data && data.url && !data.error) {
                            const assets = ls(ASSETS_STORAGE_KEY, {});
                            assets[data.url] = data.storageUrl || data.url;
                            lsSet(ASSETS_STORAGE_KEY, assets);
                            resolve({ url: data.url, markdown: data.markdown });
                        } else {
                            console.warn('[Upload] Backend upload returned error, using local fallback:', data?.error);
                            fallbackLocal();
                        }
                    })
                    .catch(err => {
                        console.warn('[Upload] Backend network failed, using local fallback:', err.message);
                        fallbackLocal();
                    });
            }).catch(err => {
                console.error('Image compression failed', err);
                resolve({ url: '', markdown: '![upload failed]()' });
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    _computeTotalHours(entries) {
        if (!Array.isArray(entries)) return 0;
        const total = entries.reduce((acc, e) => acc + (parseFloat(e.timeHours) || 0), 0);
        return Math.round(total * 100) / 100;
    }

    // Legacy compat (some callers still use this)
    _simulateLatency(ms = 0) {
        return new Promise(r => setTimeout(r, ms));
    }
}

export const api = new TrekApiService();
