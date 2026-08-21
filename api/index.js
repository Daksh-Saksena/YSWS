import { app } from '../server/server.js';
import { initSchema } from '../server/db.js';

let isSchemaInitialized = false;

export default async function handler(req, res) {
    if (!isSchemaInitialized) {
        try {
            await initSchema();
            isSchemaInitialized = true;
        } catch (e) {
            console.error('[Vercel Serverless] DB init error:', e);
        }
    }
    return app(req, res);
}
