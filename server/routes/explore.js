import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/explore
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        // 1. Fetch public projects (exclude "Final Test" and deleted projects)
        const projectsRes = await query(`
            SELECT p.id, p.name, p.tagline, p.cover_image_url, p.guild, p.total_hours,
                   u.display_name as author_name, u.avatar_url as author_avatar
            FROM projects p
            JOIN users u ON p.user_id = u.id
            WHERE p.deleted_at IS NULL
              AND p.name != 'Final Test'
              AND p.status IN ('in_progress', 'submitted', 'approved')
            ORDER BY p.created_at DESC
        `);

        // 2. Fetch Leaderboard data (all users + total hours)
        const usersRes = await query(`
            SELECT u.id, u.display_name, u.avatar_url,
                   COALESCE(SUM(p.total_hours), 0) as total_hours
            FROM users u
            LEFT JOIN projects p ON p.user_id = u.id AND p.deleted_at IS NULL
            GROUP BY u.id
            ORDER BY total_hours DESC
        `);

        // 3. Fetch all distinct journal entry dates per user for streak calculation
        const datesRes = await query(`
            SELECT author_id, entry_date
            FROM journal_entries
            WHERE deleted_at IS NULL AND author_id IS NOT NULL
            GROUP BY author_id, entry_date
            ORDER BY author_id, entry_date DESC
        `);

        // Calculate streaks
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Get yesterday's date string
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const userStreaks = {};
        
        // Initialize streaks to 0
        usersRes.rows.forEach(u => {
            userStreaks[u.id] = 0;
        });

        // Group dates by user
        const datesByUser = {};
        for (const row of datesRes.rows) {
            const dateStr = (row.entry_date instanceof Date) 
                ? row.entry_date.toISOString().split('T')[0] 
                : String(row.entry_date).split('T')[0];
            
            if (!datesByUser[row.author_id]) datesByUser[row.author_id] = [];
            datesByUser[row.author_id].push(dateStr);
        }

        // Compute consecutive streak per user
        for (const [userId, dates] of Object.entries(datesByUser)) {
            // dates are sorted DESC from SQL (but let's ensure it just in case)
            dates.sort((a, b) => b.localeCompare(a));
            
            let streak = 0;
            let expectedDate = new Date(); // Start expecting today

            // If the latest entry is neither today nor yesterday, streak is broken (0)
            if (dates[0] !== todayStr && dates[0] !== yesterdayStr) {
                userStreaks[userId] = 0;
                continue;
            }

            // If the latest entry is yesterday, start expecting yesterday
            if (dates[0] === yesterdayStr) {
                expectedDate = yesterday;
            }

            for (const dateStr of dates) {
                const expectedDateStr = expectedDate.toISOString().split('T')[0];
                if (dateStr === expectedDateStr) {
                    streak++;
                    // Step backward one day
                    expectedDate.setDate(expectedDate.getDate() - 1);
                } else {
                    break; // Streak broken
                }
            }
            userStreaks[userId] = streak;
        }

        // Attach streaks to users
        const leaderboard = usersRes.rows.map(u => ({
            ...u,
            streak: userStreaks[u.id] || 0
        }));

        const getDefaultCover = (guild) => {
            const g = (guild || '').toLowerCase();
            if (g === 'air') return 'images/jet.png';
            if (g === 'land') return 'images/red_car.png';
            if (g === 'space') return 'images/rocket.png';
            if (g === 'water') return 'images/boat.png';
            return 'images/jet.png';
        };

        const projects = projectsRes.rows.map(p => {
            if (p.cover_image_url === 'images/jet.png' || p.cover_image_url === 'jet.png' || !p.cover_image_url) {
                p.cover_image_url = getDefaultCover(p.guild);
            }
            return p;
        });

        res.json({
            projects: projects,
            leaderboard: leaderboard
        });
    } catch (err) {
        console.error('[Explore] GET / error:', err);
        res.status(500).json({ error: 'Failed to fetch explore data.' });
    }
});

export default router;
