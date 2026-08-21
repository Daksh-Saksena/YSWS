/**
 * Trek YSWS - Project Seed Data
 * 
 * Clean initial state for Trek project without fake pre-populated sample logs.
 */

export const INITIAL_TREK_PROJECTS = [
    {
        id: 'my-trek-project',
        name: 'My Trek Project',
        guild: 'frontier',
        tagline: 'Documenting my hardware build journey on Trek',
        description: 'Track your physical prototypes, 3D models, electronics, and field testing.',
        coverImageUrl: 'jet.png',
        status: 'draft',
        authorName: 'Trek Builder',
        authorAvatar: 'images/flag.png',
        devlogMode: 'web',
        reviewType: 'design',
        linkedDesignProjectId: null,
        repoUrl: null,
        links: [],
        totalHours: 0,
        journalEntries: [],
        reviewFeedback: null,
        submittedAt: null,
        createdAt: new Date().toISOString().split('T')[0]
    }
];
