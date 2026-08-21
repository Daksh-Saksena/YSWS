/**
 * Trek YSWS — Express Backend
 *
 * Starts the API server with:
 *  - CORS locked to frontend origin
 *  - Helmet security headers
 *  - Rate limiting (100 req/min globally, 10 req/min for auth)
 *  - Routes: /auth, /api/projects, /api/journals, /api/uploads
 *  - Scheduled cron backup every 6 hours (Safety Layer 8)
 *  - Graceful shutdown (Safety Layer — flushes in-flight writes)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';

import { initSchema } from './db.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import journalRoutes from './routes/journals.js';
import uploadRoutes from './routes/uploads.js';
import exploreRoutes from './routes/explore.js';
import { runBackup } from './jobs/backup.js';

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// Security & middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use(helmet());

app.use(cors({
    origin: [
        FRONTEND_URL,
        'https://ysws-sigma.vercel.app',
        'http://localhost:8000',
        'http://127.0.0.1:8000',
        /\.vercel\.app$/
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Global rate limit: 200 requests per minute per IP
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
}));

// Stricter limit for auth routes (prevent brute force)
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many auth attempts. Please wait a moment.' },
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/auth', authLimiter, authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/journals', journalRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/explore', exploreRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[Server] Unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
});

async function start() {
    try {
        await initSchema();
        const server = app.listen(PORT, () => {
            console.log(`\n🚀 Trek backend running on http://localhost:${PORT}`);
            console.log(`   Frontend URL: ${FRONTEND_URL}`);
            console.log(`   Environment:  ${process.env.NODE_ENV || 'development'}\n`);
        });

        // Safety Layer 8: Schedule pg_dump backup every 6 hours
        cron.schedule('0 */6 * * *', () => {
            console.log('[Cron] Running scheduled backup...');
            runBackup().catch(e => console.error('[Cron] Backup failed:', e));
        });

        const shutdown = async (signal) => {
            console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);
            server.close(() => {
                console.log('[Server] HTTP server closed. Bye!');
                process.exit(0);
            });
            setTimeout(() => process.exit(1), 10_000).unref();
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT',  () => shutdown('SIGINT'));
    } catch (err) {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    }
}

export { app, start };
export default app;

// Run standalone only if executed directly
if (process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server'))) {
    start();
}
