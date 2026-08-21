import { api } from './api.js?v=5';

const DOCS_TREE = [
    { title: "Welcome to Trek", path: "docs/index.md" },
    {
        title: "About Trek",
        children: [
            { title: "How it Works", path: "docs/about-trek/how-it-works.md" },
            { title: "Tiers & Streaks", path: "docs/about-trek/tiers.md" },
            { title: "FAQ", path: "docs/about-trek/FAQ.md" }
        ]
    },
    {
        title: "Requirements",
        children: [
            { title: "Project Guidelines", path: "docs/requirements/project-guidelines.md" },
            { title: "Shipping", path: "docs/requirements/shipping.md" },
            { title: "Submitting", path: "docs/requirements/submitting.md" }
        ]
    },
    {
        title: "Design",
        children: [
            { title: "Cost & Funding", path: "docs/design/cost.md" },
            { title: "Sourcing Parts", path: "docs/design/sourcing-parts.md" },
            { title: "How to Write a README", path: "docs/design/readme.md" },
            { title: "How to Journal", path: "docs/design/how-to-journal.md" },
            { title: "Journal Format", path: "docs/design/journal-format.md" }
        ]
    }
];

class DocsController {
    constructor() {
        this.currentDocPath = "docs/index.md";
        this.init();
    }

    async init() {
        this.renderSidebar();
        
        // Handle URL params
        const params = new URLSearchParams(window.location.search);
        const docParam = params.get('doc');
        if (docParam) {
            this.currentDocPath = decodeURIComponent(docParam);
        }

        // Browser Back / Forward support
        window.addEventListener('popstate', () => {
            const p = new URLSearchParams(window.location.search);
            const doc = p.get('doc') || 'docs/index.md';
            if (doc !== this.currentDocPath) {
                this.currentDocPath = doc;
                this.renderSidebar();
                this.loadDoc(this.currentDocPath);
            }
        });

        await this.loadDoc(this.currentDocPath);
    }

    resolveDocPath(href) {
        if (!href) return null;
        let clean = href.trim();
        clean = clean.replace(/^(\.\/|\/)/, '');
        
        if (clean.startsWith('docs/')) {
            clean = clean.substring(5);
        }
        
        // Common aliases & redirects
        if (clean === 'submission-guidelines' || clean === 'requirements/submission-guidelines') {
            clean = 'requirements/submitting';
        }
        if (clean === 'pitching' || clean === 'requirements/pitching') {
            clean = 'requirements/project-guidelines';
        }
        
        if (!clean.endsWith('.md')) {
            clean += '.md';
        }
        
        return `docs/${clean}`;
    }

    renderSidebar() {
        const container = document.getElementById('docs-sidebar-container');
        if (!container) return;

        let html = `<h3>Documentation</h3>`;

        DOCS_TREE.forEach(node => {
            if (node.children) {
                html += `<div class="docs-category">
                    <div class="docs-category-title">${node.title}</div>
                    ${node.children.map(child => `
                        <a href="?doc=${encodeURIComponent(child.path)}" class="docs-nav-link ${this.currentDocPath === child.path ? 'active' : ''}" data-path="${child.path}">
                            ${child.title}
                        </a>
                    `).join('')}
                </div>`;
            } else {
                html += `<a href="?doc=${encodeURIComponent(node.path)}" class="docs-nav-link ${this.currentDocPath === node.path ? 'active' : ''}" data-path="${node.path}" style="margin-bottom: 24px; font-weight: 700;">
                    ${node.title}
                </a>`;
            }
        });

        container.innerHTML = html;

        // Intercept clicks on sidebar to update doc smoothly
        const links = container.querySelectorAll('.docs-nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const path = link.getAttribute('data-path');
                
                const url = new URL(window.location);
                url.searchParams.set('doc', path);
                window.history.pushState({}, '', url);

                this.currentDocPath = path;
                this.renderSidebar(); // Update active state
                this.loadDoc(path);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    }

    async loadDoc(path) {
        const container = document.getElementById('docs-markdown-container');
        if (!container) return;

        container.innerHTML = `<div style="color: var(--hc-muted); text-align: center; padding: 40px;">Loading...</div>`;

        try {
            const res = await fetch(path);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const text = await res.text();
            
            // Strip leading markdown table or YAML frontmatter cleanly even if there are leading spaces/newlines
            let cleanText = text.trim();
            cleanText = cleanText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
            cleanText = cleanText.replace(/^(?:\|[^\r\n]+\|\s*\r?\n)+/, '').trim();
            
            // Reusing Markdown logic from TrekProjectController with small tweaks
            const parsed = marked.parse(cleanText);
            
            // Post-process to handle image rendering properly
            let html = parsed;
            
            html = html.replace(/<img([^>]*)src="([^"]+)"([^>]*)>/gi, (match, p1, src, p2) => {
                const isAbsolute = src.startsWith('http') || src.startsWith('data:');
                let finalSrc = src;
                
                if (!isAbsolute) {
                    if (src.startsWith('../')) {
                         finalSrc = src.replace('../', '');
                    }
                }
                
                return `<img class="devlog-md-img" src="${finalSrc}" ${p1} ${p2} />`;
            });
            
            container.innerHTML = html;

            // Intercept internal doc links so they don't 404 navigate
            container.querySelectorAll('a').forEach(a => {
                const rawHref = a.getAttribute('href');
                if (!rawHref) return;

                if (rawHref.startsWith('http://') || rawHref.startsWith('https://') || rawHref.startsWith('mailto:')) {
                    a.setAttribute('target', '_blank');
                    a.setAttribute('rel', 'noopener');
                    return;
                }

                if (rawHref.startsWith('#')) {
                    return;
                }

                const targetDoc = this.resolveDocPath(rawHref);
                if (targetDoc) {
                    a.setAttribute('href', `?doc=${encodeURIComponent(targetDoc)}`);
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        const url = new URL(window.location);
                        url.searchParams.set('doc', targetDoc);
                        window.history.pushState({}, '', url);

                        this.currentDocPath = targetDoc;
                        this.renderSidebar();
                        this.loadDoc(targetDoc);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    });
                }
            });

        } catch (err) {
            console.error('Failed to load documentation:', err);
            container.innerHTML = `
                <div style="color: var(--hc-red); padding: 20px; border: 1px solid var(--hc-red); border-radius: 8px; background: rgba(236, 55, 80, 0.1);">
                    <strong>Error loading document:</strong> ${err.message}<br>
                    <small>Path: ${path}</small>
                </div>
            `;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.docsController = new DocsController();
});
