/**
 * Trek YSWS - Core Types & Data Contracts
 * 
 * Hardware-centric Project & Journal Data Definitions
 */

/**
 * @typedef {'air' | 'water' | 'land' | 'frontier'} GuildType
 */

/**
 * @typedef {'draft' | 'in_progress' | 'submitted' | 'approved' | 'returned'} ProjectStatus
 */

/**
 * @typedef {Object} TrekJournalEntry
 * @property {string} id - Unique identifier (e.g. 'entry-101')
 * @property {string} projectId - Associated Project ID
 * @property {string} title - Brief title of the build log entry
 * @property {string} date - ISO Date string (YYYY-MM-DD)
 * @property {string} content - Markdown content describing the build progress
 * @property {string} timeSpent - Raw time string as entered by user (e.g. '2h 30m')
 * @property {number} timeHours - Normalized decimal hours (e.g. 2.5)
 * @property {string[]} images - Array of image URLs or data URLs attached to this entry
 * @property {'draft' | 'published'} status
 * @property {string} createdAt - Timestamp
 * @property {string} updatedAt - Timestamp
 */

/**
 * @typedef {Object} TrekProject
 * @property {string} id - Unique project slug/ID (e.g. 'my-trek-project')
 * @property {string} name - Project Title
 * @property {GuildType} guild - One of the 4 Trek Guilds
 * @property {string} tagline - Short summary
 * @property {string} description - Project overview
 * @property {string} coverImageUrl - Banner / photo of the build
 * @property {ProjectStatus} status - Project lifecycle state
 * @property {string} authorName - Creator name
 * @property {string} authorAvatar - Creator avatar URL
 * @property {number} totalHours - Calculated sum of build log hours
 * @property {TrekJournalEntry[]} journalEntries - Chronological build log entries
 * @property {string | null} reviewFeedback - Staff reviewer comments
 * @property {string | null} submittedAt - Timestamp when submitted for review
 * @property {string} createdAt - Project start date
 */

export const GUILD_METADATA = {
    air: {
        name: 'Air Guild',
        tagline: 'Dream Above the Clouds',
        accentColor: '#5bc0de'
    },
    water: {
        name: 'Water Guild',
        tagline: 'Master the Depths & Seas',
        accentColor: '#338eda'
    },
    land: {
        name: 'Land Guild',
        tagline: 'Conquer Every Terrain',
        accentColor: '#ff8c37'
    },
    frontier: {
        name: 'Frontier Guild',
        tagline: 'Push Beyond the Ordinary',
        accentColor: '#a633d6'
    }
};
