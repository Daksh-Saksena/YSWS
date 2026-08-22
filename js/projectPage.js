/**
 * Trek YSWS - Project & Hardware Journal UI Controller
 * Orchestrates interactive build logs, Forge-style inline DevLog creator,
 * clipboard image paste/drop/preview, live time parsing, validation,
 * project details editing, fixed Web/Git mode handling, and review pipeline.
 */

import { api } from './api.js?v=5';
import { GUILD_METADATA } from './types.js';
import { TrekTimeParser } from './timeParser.js';
import { TrekJournalValidator } from './journalValidator.js';

class TrekProjectController {
    constructor() {
        this.currentProjectId = 'my-trek-project';
        this.currentProject = null;
        this.pendingCoverUrl = null;
        this.editorMode = 'write';
        this.editingEntryId = null;
        this.devlogMode = 'web'; // 'web' | 'git'

        this.init();
    }

    resolveAsset(url) {
        if (!url) return '';
        if (typeof api?.resolveAssetUrl === 'function') {
            return api.resolveAssetUrl(url);
        }
        try {
            const raw = localStorage.getItem('trek_ysws_assets_db_v1');
            if (raw) {
                const db = JSON.parse(raw);
                if (db && db[url]) return db[url];
            }
        } catch (e) { }
        return url;
    }

    async init() {
        if (!api.isLoggedIn()) {
            window.location.href = 'login.html';
            return;
        }
        this.bindGlobalEvents();
        this.bindProjectEditEvents();
        this.setupInlineDevlogEditor();
        await this.loadProject();
    }

    async loadProject() {
        try {
            const params = new URLSearchParams(window.location.search);
            const projectIdParam = params.get('projectId');
            const modeParam = params.get('mode');
            const repoParam = params.get('repo');

            if (projectIdParam) {
                this.currentProject = await api.getProject(projectIdParam);
            }

            if (!this.currentProject) {
                const projects = await api.getProjects();
                if (projects && projects.length > 0) {
                    this.currentProject = await api.getProject(projects[0].id) || projects[0];
                } else {
                    this.currentProject = await api.createProject({
                        name: 'My Trek Project',
                        guild: 'frontier',
                        tagline: 'Documenting my hardware build journey on Trek',
                        devlogMode: modeParam || 'web',
                        repoUrl: repoParam ? decodeURIComponent(repoParam) : null
                    });
                }
            }

            if (modeParam && !this.currentProject.devlogMode) {
                this.currentProject.devlogMode = modeParam;
                await api.updateProject(this.currentProject.id, { devlogMode: modeParam });
            }

            if (repoParam && !this.currentProject.repoUrl) {
                this.currentProject.repoUrl = decodeURIComponent(repoParam);
                await api.updateProject(this.currentProject.id, { repoUrl: this.currentProject.repoUrl });
            }

            this.currentProjectId = this.currentProject.id;
            this.devlogMode = this.currentProject.devlogMode || 'web';

            await this.renderProjectHero();
            this.renderReviewBanner();
            this.applyProjectMode();
            this.restoreDraft();
        } catch (err) {
            console.error('Failed to load project:', err);
            if (err.status === 401 || !api.isLoggedIn()) {
                window.location.href = 'login.html';
            }
        }
    }

    applyProjectMode() {
        const mode = this.currentProject?.devlogMode || 'web';
        const webTimeline = document.getElementById('journal-timeline');
        const gitView = document.getElementById('git-journal-view');
        const toggleEntryBtn = document.getElementById('toggle-entry-form-btn');
        const sectionTitle = document.getElementById('section-title');
        const modePill = document.getElementById('project-mode-pill');

        if (modePill) {
            modePill.textContent = mode === 'git' ? 'GIT JOURNAL' : 'WEB JOURNAL';
        }

        if (mode === 'git') {
            if (webTimeline) webTimeline.style.display = 'none';
            if (gitView) gitView.style.display = 'block';
            if (toggleEntryBtn) toggleEntryBtn.style.display = 'none';
            if (sectionTitle) sectionTitle.textContent = 'Git Journal';
            this.hideInlineForm();
            this.renderGitJournalView();
        } else {
            if (webTimeline) webTimeline.style.display = 'flex';
            if (gitView) gitView.style.display = 'none';
            if (toggleEntryBtn) toggleEntryBtn.style.display = 'inline-flex';
            if (sectionTitle) sectionTitle.textContent = 'DevLog';
            this.renderTimeline();
        }
    }

    renderGitJournalView() {
        const p = this.currentProject;
        if (!p) return;

        let repoUrl = p.repoUrl || 'https://github.com/hackclub/trek-hardware';
        let displayName = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\/?/i, '').replace(/\/$/, '') || 'github.com/your-repo';

        const nameEl = document.getElementById('git-repo-display-name');
        const extLink = document.getElementById('git-repo-external-link');
        const fallbackUrl = document.getElementById('git-fallback-url-text');
        const fallbackBtn = document.getElementById('git-fallback-btn');
        const iframe = document.getElementById('git-repo-iframe');

        if (nameEl) nameEl.textContent = displayName;
        if (extLink) extLink.href = repoUrl;
        if (fallbackUrl) fallbackUrl.textContent = repoUrl;
        if (fallbackBtn) fallbackBtn.href = repoUrl;

        if (iframe) {
            iframe.src = repoUrl;
        }
    }

    bindGlobalEvents() {
        // Review Modal triggers
        document.getElementById('submit-review-trigger-btn')?.addEventListener('click', () => this.openReviewModal());
        document.getElementById('close-review-modal-btn')?.addEventListener('click', () => this.closeReviewModal());
        document.getElementById('cancel-review-modal-btn')?.addEventListener('click', () => this.closeReviewModal());
        document.getElementById('confirm-submit-review-btn')?.addEventListener('click', () => this.handleSubmitReview());

        // Team / Collaborator Modal triggers
        document.getElementById('open-team-modal-btn')?.addEventListener('click', () => this.openTeamModal());
        document.getElementById('close-team-modal-btn')?.addEventListener('click', () => this.closeTeamModal());
        document.getElementById('done-team-modal-btn')?.addEventListener('click', () => this.closeTeamModal());
        document.getElementById('invite-collab-form')?.addEventListener('submit', (e) => this.handleInviteCollabSubmit(e));
    }

    setupInlineDevlogEditor() {
        const toggleBtn = document.getElementById('toggle-entry-form-btn');
        const closeBtn = document.getElementById('close-inline-form-btn');
        const cancelBtn = document.getElementById('cancel-inline-entry-btn');
        const form = document.getElementById('entry-form');
        const timeInput = document.getElementById('entry-time-input');
        const textarea = document.getElementById('entry-content-input');
        const browseBtn = document.getElementById('btn-browse-images');
        const fileInput = document.getElementById('image-file-input');
        const tabWrite = document.getElementById('tab-write-btn');
        const tabPreview = document.getElementById('tab-preview-btn');

        // Toggle Form
        toggleBtn?.addEventListener('click', () => {
            const container = document.getElementById('inline-entry-container');
            if (container && container.style.display !== 'none' && !this.editingEntryId) {
                this.hideInlineForm();
            } else {
                this.showInlineForm();
            }
        });

        const handleCancel = () => {
            const hasContent = document.getElementById('entry-title-input')?.value.trim() ||
                               document.getElementById('entry-time-input')?.value.trim() ||
                               document.getElementById('entry-content-input')?.value.trim();
            if (hasContent) {
                if (confirm('Discard your unsaved draft?')) {
                    this.clearDraft();
                    this.hideInlineForm();
                }
            } else {
                this.clearDraft();
                this.hideInlineForm();
            }
        };

        closeBtn?.addEventListener('click', handleCancel);
        cancelBtn?.addEventListener('click', handleCancel);

        // Editor tab switches (Write vs Preview)
        tabWrite?.addEventListener('click', () => this.setEditorTab('write'));
        tabPreview?.addEventListener('click', () => this.setEditorTab('preview'));

        // Title input live draft save
        const titleInput = document.getElementById('entry-title-input');
        if (titleInput) {
            titleInput.addEventListener('input', () => this.saveDraft());
        }

        // Time spent live parsing and draft save
        if (timeInput) {
            timeInput.addEventListener('input', () => {
                const preview = document.getElementById('time-parsed-preview');
                const parsed = TrekTimeParser.parse(timeInput.value);
                if (parsed !== null) {
                    preview.textContent = `(Parsed: ${TrekTimeParser.formatFriendly(parsed)})`;
                    preview.style.color = '#33d6a6';
                } else if (timeInput.value.trim().length > 0) {
                    preview.textContent = `(Invalid time format)`;
                    preview.style.color = '#ff6b81';
                } else {
                    preview.textContent = '';
                }
                this.saveDraft();
            });
        }

        // Live content counter & validator & draft save
        if (textarea) {
            textarea.addEventListener('input', () => {
                this.updateContentCounters();
                this.saveDraft();
            });

            // Clipboard Paste for Images (like Forge)
            textarea.addEventListener('paste', (e) => {
                const items = Array.from(e.clipboardData?.items || []);
                const imageFiles = items
                    .filter(item => item.type.startsWith('image/'))
                    .map(item => item.getAsFile())
                    .filter(file => file !== null);

                if (imageFiles.length > 0) {
                    e.preventDefault();
                    this.uploadImagesIntoContent(imageFiles, textarea);
                }
            });

            // Drag and Drop Images (like Forge)
            textarea.addEventListener('dragover', (e) => {
                if (e.dataTransfer?.types?.includes('Files')) {
                    e.preventDefault();
                }
            });

            textarea.addEventListener('drop', (e) => {
                const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
                if (files.length > 0) {
                    e.preventDefault();
                    this.uploadImagesIntoContent(files, textarea);
                }
            });
        }

        // Save draft on window beforeunload
        window.addEventListener('beforeunload', () => this.saveDraft());

        // File Browser Button for Images
        if (browseBtn && fileInput) {
            browseBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', () => {
                if (fileInput.files?.length && textarea) {
                    const files = Array.from(fileInput.files);
                    this.uploadImagesIntoContent(files, textarea);
                    fileInput.value = '';
                }
            });
        }

        // Form Submit
        form?.addEventListener('submit', (e) => this.handleEntryFormSubmit(e));
    }

    showInlineForm(entryToEdit = null) {
        const container = document.getElementById('inline-entry-container');
        const toggleBtn = document.getElementById('toggle-entry-form-btn');
        const form = document.getElementById('entry-form');
        const formTitle = document.getElementById('inline-form-title');
        const timePreview = document.getElementById('time-parsed-preview');
        const submitBtn = document.getElementById('save-entry-btn');

        if (!container) return;

        if (entryToEdit) {
            this.editingEntryId = entryToEdit.id;
            if (formTitle) formTitle.textContent = 'Edit DevLog Entry';
            if (submitBtn) submitBtn.textContent = 'Update DevLog →';
            document.getElementById('entry-id-input').value = entryToEdit.id;
            document.getElementById('entry-title-input').value = entryToEdit.title;
            document.getElementById('entry-time-input').value = entryToEdit.timeSpent;
            document.getElementById('entry-content-input').value = entryToEdit.content;

            if (timePreview) {
                timePreview.textContent = `(Parsed: ${TrekTimeParser.formatFriendly(entryToEdit.timeHours)})`;
                timePreview.style.color = '#33d6a6';
            }
        } else {
            this.editingEntryId = null;
            if (formTitle) formTitle.textContent = 'New DevLog Entry';
            if (submitBtn) submitBtn.textContent = 'Post DevLog →';
            form?.reset();
            document.getElementById('entry-id-input').value = '';
            if (timePreview) timePreview.textContent = '';
        }

        this.setEditorTab('write');
        this.updateContentCounters();

        container.style.display = 'block';
        if (toggleBtn) {
            toggleBtn.textContent = 'Cancel';
            toggleBtn.className = 'btn-secondary';
        }

        // Smooth scroll to form
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    hideInlineForm() {
        const container = document.getElementById('inline-entry-container');
        const toggleBtn = document.getElementById('toggle-entry-form-btn');
        const form = document.getElementById('entry-form');

        if (container) container.style.display = 'none';
        if (toggleBtn) {
            toggleBtn.textContent = '+ New Entry';
            toggleBtn.className = 'btn-primary';
        }
        form?.reset();
        this.editingEntryId = null;
    }

    async uploadImagesIntoContent(files, textarea) {
        if (!files || files.length === 0 || !textarea) return;

        const currentVal = textarea.value;
        const placeholders = files.map((file, i) => `![Uploading ${file.name || `image-${i + 1}`}...]()`);
        const selStart = textarea.selectionStart ?? currentVal.length;
        const selEnd = textarea.selectionEnd ?? currentVal.length;
        const before = currentVal.slice(0, selStart);
        const after = currentVal.slice(selEnd);

        const prefix = (before.length > 0 && !before.endsWith('\n')) ? '\n' : '';
        const suffix = (after.length > 0 && !after.startsWith('\n')) ? '\n' : '';

        textarea.value = before + prefix + placeholders.join('\n') + suffix + after;
        this.updateContentCounters();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const placeholder = placeholders[i];
            try {
                const uploaded = await api.uploadEvidence(file);
                const altText = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'Build Evidence';
                const mdTag = `![${altText}](${uploaded.url})`;
                textarea.value = textarea.value.replace(placeholder, mdTag);
            } catch (err) {
                textarea.value = textarea.value.replace(placeholder, '![upload failed]()');
                console.error('Image upload failed:', err);
            }
            this.updateContentCounters();
            this.saveDraft();
        }

        if (this.editorMode === 'preview') {
            this.setEditorTab('preview');
        }
    }

    saveDraft() {
        if (!this.currentProjectId) return;
        const title = document.getElementById('entry-title-input')?.value || '';
        const timeSpent = document.getElementById('entry-time-input')?.value || '';
        const content = document.getElementById('entry-content-input')?.value || '';

        if (title.trim() || timeSpent.trim() || content.trim()) {
            const draft = {
                title,
                timeSpent,
                content,
                editingEntryId: this.editingEntryId || null,
                updatedAt: Date.now()
            };
            try {
                localStorage.setItem(`trek_journal_draft_${this.currentProjectId}`, JSON.stringify(draft));
            } catch (e) {
                console.warn('[Draft] Failed to save draft to localStorage:', e);
            }
        } else {
            this.clearDraft();
        }
    }

    clearDraft() {
        if (!this.currentProjectId) return;
        try {
            localStorage.removeItem(`trek_journal_draft_${this.currentProjectId}`);
        } catch (e) {}
    }

    restoreDraft() {
        if (!this.currentProjectId) return false;
        try {
            const raw = localStorage.getItem(`trek_journal_draft_${this.currentProjectId}`);
            if (!raw) return false;
            const draft = JSON.parse(raw);
            if (!draft || (!draft.title && !draft.timeSpent && !draft.content)) return false;

            const titleInput = document.getElementById('entry-title-input');
            const timeInput = document.getElementById('entry-time-input');
            const contentInput = document.getElementById('entry-content-input');
            const timePreview = document.getElementById('time-parsed-preview');

            if (titleInput) titleInput.value = draft.title || '';
            if (timeInput) {
                timeInput.value = draft.timeSpent || '';
                const parsed = TrekTimeParser.parse(draft.timeSpent || '');
                if (parsed !== null && timePreview) {
                    timePreview.textContent = `(Parsed: ${TrekTimeParser.formatFriendly(parsed)})`;
                    timePreview.style.color = '#33d6a6';
                }
            }
            if (contentInput) contentInput.value = draft.content || '';

            if (draft.editingEntryId) {
                this.editingEntryId = draft.editingEntryId;
                const idInput = document.getElementById('entry-id-input');
                if (idInput) idInput.value = draft.editingEntryId;
                const formTitle = document.getElementById('inline-form-title');
                const submitBtn = document.getElementById('save-entry-btn');
                if (formTitle) formTitle.textContent = 'Edit DevLog Entry (Draft Restored)';
                if (submitBtn) submitBtn.textContent = 'Update DevLog →';
            }

            this.updateContentCounters();

            // Reveal the inline form with restored draft
            const container = document.getElementById('inline-entry-container');
            const toggleBtn = document.getElementById('toggle-entry-form-btn');
            if (container) container.style.display = 'block';
            if (toggleBtn) {
                toggleBtn.textContent = 'Cancel';
                toggleBtn.className = 'btn-secondary';
            }

            const statusText = document.getElementById('validation-status-text');
            if (statusText) {
                statusText.textContent = '💾 Restored unsaved draft';
                statusText.style.color = '#ffb020';
            }

            return true;
        } catch (e) {
            console.warn('[Draft] Failed to restore draft:', e);
            return false;
        }
    }

    getContentWithoutLinks(content) {
        if (!content) return '';
        let text = content.replace(/!\[([^\]]*)\]\([^\)]+\)/g, ''); // remove image markdown
        text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // remove link markdown
        text = text.replace(/[<>]/g, '');
        return text.trim();
    }

    hasImage(content) {
        if (!content) return false;
        return (content.includes('![') && content.includes('](')) || content.includes('<img');
    }

    updateContentCounters() {
        const textarea = document.getElementById('entry-content-input');
        const counterEl = document.getElementById('char-image-counter');
        const statusEl = document.getElementById('validation-status-text');
        if (!textarea || !counterEl) return;

        const content = textarea.value || '';
        const textWithoutLinks = this.getContentWithoutLinks(content);
        const hasImg = this.hasImage(content);
        const charCount = textWithoutLinks.length;
        const minChar = 80;

        const charMet = charCount >= minChar;
        const imgMet = hasImg;

        counterEl.innerHTML = `
            <span style="color: ${charMet ? '#33d6a6' : '#8492a6'}; font-weight: ${charMet ? '600' : 'normal'};">${charCount}/${minChar} characters</span>, 
            <span style="color: ${imgMet ? '#33d6a6' : '#8492a6'}; font-weight: ${imgMet ? '600' : 'normal'};">${imgMet ? '✓ Image attached' : '0/1 images'}</span>
        `;

        if (statusEl) {
            if (charMet && imgMet) {
                statusEl.innerHTML = '<span style="color: #33d6a6; font-weight: 700;">✓ Ready to post</span>';
            } else {
                statusEl.innerHTML = '<span style="color: #8492a6;">Add details & image proof</span>';
            }
        }
    }

    setEditorTab(mode) {
        this.editorMode = mode;
        const writeBtn = document.getElementById('tab-write-btn');
        const previewBtn = document.getElementById('tab-preview-btn');
        const writeArea = document.getElementById('editor-write-area');
        const previewArea = document.getElementById('entry-preview-area');
        const textarea = document.getElementById('entry-content-input');

        if (mode === 'write') {
            if (writeBtn) {
                writeBtn.style.background = 'rgba(255,255,255,0.12)';
                writeBtn.style.color = 'white';
            }
            if (previewBtn) {
                previewBtn.style.background = 'transparent';
                previewBtn.style.color = 'var(--hc-muted)';
            }
            if (writeArea) writeArea.style.display = 'block';
            if (previewArea) previewArea.style.display = 'none';
        } else {
            if (writeBtn) {
                writeBtn.style.background = 'transparent';
                writeBtn.style.color = 'var(--hc-muted)';
            }
            if (previewBtn) {
                previewBtn.style.background = 'rgba(255,255,255,0.12)';
                previewBtn.style.color = 'white';
            }
            if (writeArea) writeArea.style.display = 'none';
            if (previewArea) {
                previewArea.style.display = 'block';
                const text = textarea?.value || '';
                previewArea.innerHTML = text.trim()
                    ? this.parseMarkdown(text)
                    : '<em style="color: var(--hc-muted);">Nothing to preview yet. Write text and paste photos in the Write tab.</em>';
            }
        }
    }

    async handleEntryFormSubmit(e) {
        e.preventDefault();
        if (this.isSubmittingEntry) return;

        const title = document.getElementById('entry-title-input')?.value.trim();
        const timeSpent = document.getElementById('entry-time-input')?.value.trim();
        const content = document.getElementById('entry-content-input')?.value.trim();
        const submitBtn = document.getElementById('save-entry-btn');

        if (!title) {
            alert('Please provide an entry title.');
            return;
        }

        const parsedTime = TrekTimeParser.parse(timeSpent);
        if (parsedTime === null) {
            alert('Please enter a valid time duration (e.g. "2h 30m", "1.5 hrs", "45 mins").');
            return;
        }

        const textWithoutLinks = this.getContentWithoutLinks(content);
        const hasImg = this.hasImage(content);

        if (textWithoutLinks.length < 80) {
            alert(`Your build log is too short (${textWithoutLinks.length}/80 characters). Please write at least 80 characters describing what you worked on.`);
            return;
        }

        if (!hasImg) {
            alert('Please attach at least 1 image/photo proof of your build progress (paste or click Browse).');
            return;
        }

        // Extract image URLs from markdown content
        const extractedImages = [];
        const imgRegex = /!\[.*?\]\((.*?)\)/g;
        let match;
        while ((match = imgRegex.exec(content)) !== null) {
            extractedImages.push(match[1]);
        }

        this.isSubmittingEntry = true;
        const originalBtnText = submitBtn ? submitBtn.textContent : 'Post DevLog →';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.6';
            submitBtn.textContent = this.editingEntryId ? 'Updating...' : 'Posting...';
        }

        try {
            let res;
            if (this.editingEntryId) {
                const existing = this.currentProject?.journalEntries?.find(e => e.id === this.editingEntryId);
                res = await api.updateJournalEntry(this.currentProjectId, this.editingEntryId, {
                    title,
                    date: existing ? existing.date : new Date().toISOString().split('T')[0],
                    timeSpent,
                    content,
                    images: extractedImages
                });
            } else {
                res = await api.createJournalEntry(this.currentProjectId, {
                    title,
                    date: new Date().toISOString().split('T')[0],
                    timeSpent,
                    content,
                    images: extractedImages
                });
            }

            this.clearDraft();
            this.hideInlineForm();
            if (res && res.project) {
                this.currentProject = res.project;
                await this.renderProjectHero();
                this.renderTimeline();
                this.renderReviewBanner();
            } else {
                await this.loadProject();
            }
        } catch (err) {
            alert(`Error saving entry: ${err.message}`);
        } finally {
            this.isSubmittingEntry = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.textContent = originalBtnText;
            }
        }
    }

    bindProjectEditEvents() {
        // Edit Project Modal
        document.getElementById('open-edit-project-btn')?.addEventListener('click', () => this.openEditProjectModal());
        document.getElementById('close-project-modal-btn')?.addEventListener('click', () => this.closeEditProjectModal());
        document.getElementById('cancel-project-modal-btn')?.addEventListener('click', () => this.closeEditProjectModal());
        document.getElementById('project-details-form')?.addEventListener('submit', (e) => this.handleProjectFormSubmit(e));

        // Delete Current Project
        document.getElementById('delete-current-project-btn')?.addEventListener('click', async () => {
            if (!this.currentProject) return;
            const confirmed = confirm(`Are you sure you want to delete "${this.currentProject.name}"? This action cannot be undone.`);
            if (confirmed) {
                try {
                    if (typeof api.deleteProject === 'function') {
                        await api.deleteProject(this.currentProjectId);
                    } else {
                        const STORAGE_KEY = 'trek_ysws_projects_db_v2';
                        let raw = localStorage.getItem(STORAGE_KEY);
                        if (raw) {
                            let list = JSON.parse(raw);
                            list = list.filter(p => p.id !== this.currentProjectId);
                            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
                        }
                    }
                    window.location.href = 'projects.html';
                } catch (err) {
                    alert(`Failed to delete project: ${err.message}`);
                }
            }
        });

        // Modal Cover Upload Drop Zone
        const coverDropZone = document.getElementById('cover-drop-zone');
        const coverFileInput = document.getElementById('cover-file-input');

        if (coverDropZone && coverFileInput) {
            coverDropZone.addEventListener('click', () => coverFileInput.click());
            coverFileInput.addEventListener('change', async () => {
                if (coverFileInput.files?.length) {
                    try {
                        const uploaded = await api.uploadEvidence(coverFileInput.files[0]);
                        this.pendingCoverUrl = uploaded.url;
                        const previewContainer = document.getElementById('cover-preview-container');
                        const previewImg = document.getElementById('cover-preview-img');
                        if (previewContainer && previewImg) {
                            previewImg.src = uploaded.url;
                            previewContainer.style.display = 'block';
                        }
                    } catch (err) {
                        alert(`Failed to upload image: ${err.message}`);
                    }
                }
            });
        }
    }

    openEditProjectModal() {
        if (!this.currentProject) return;
        document.getElementById('project-title-input').value = this.currentProject.name || '';
        document.getElementById('project-guild-select').value = this.currentProject.guild || 'frontier';
        document.getElementById('project-tagline-input').value = this.currentProject.tagline || '';

        const repoInput = document.getElementById('project-repo-input');
        if (repoInput) {
            repoInput.value = this.currentProject.repoUrl || '';
        }

        this.pendingCoverUrl = this.currentProject.coverImageUrl || null;

        const previewContainer = document.getElementById('cover-preview-container');
        const previewImg = document.getElementById('cover-preview-img');
        if (previewContainer && previewImg && this.pendingCoverUrl) {
            previewImg.src = this.resolveAsset(this.pendingCoverUrl);
            previewContainer.style.display = 'block';
        } else if (previewContainer) {
            previewContainer.style.display = 'none';
        }

        document.getElementById('project-details-modal')?.classList.add('active');
    }

    closeEditProjectModal() {
        document.getElementById('project-details-modal')?.classList.remove('active');
    }

    async handleProjectFormSubmit(e) {
        e.preventDefault();
        const name = document.getElementById('project-title-input').value.trim();
        const guild = document.getElementById('project-guild-select').value;
        const tagline = document.getElementById('project-tagline-input').value.trim();
        const repoUrl = document.getElementById('project-repo-input')?.value.trim() || null;

        try {
            const updateData = { name, guild, tagline, repoUrl };
            if (this.pendingCoverUrl) {
                updateData.coverImageUrl = this.pendingCoverUrl;
            }
            await api.updateProject(this.currentProjectId, updateData);
            this.closeEditProjectModal();
            await this.loadProject();
        } catch (err) {
            alert(`Failed to update project: ${err.message}`);
        }
    }

    async renderProjectHero() {
        const p = this.currentProject;
        if (!p) return;

        const guild = GUILD_METADATA[p.guild] || GUILD_METADATA.frontier;

        // Badge
        const badgeContainer = document.getElementById('guild-badge-container');
        if (badgeContainer) {
            badgeContainer.innerHTML = `
                <div class="guild-badge guild-${p.guild}">
                    <span>${guild.name}</span>
                </div>
            `;
        }

        // Title & Description
        document.getElementById('project-name').textContent = p.name;

        let taglineText = p.tagline || '';

        // Handle Build Review Subtitle
        if (p.reviewType === 'build' && p.linkedDesignProjectId) {
            try {
                const linkedProject = await api.getProject(p.linkedDesignProjectId);
                if (linkedProject) {
                    const taglineEl = document.getElementById('project-tagline');
                    taglineEl.innerHTML = `Build review of <a href="project.html?projectId=${linkedProject.id}" style="color: var(--hc-red); text-decoration: none;">${this.escapeHtml(linkedProject.name)}</a><br><span style="font-size: 0.9em; opacity: 0.8;">${this.escapeHtml(taglineText)}</span>`;
                }
            } catch (err) {
                console.error('Could not load linked project', err);
                document.getElementById('project-tagline').textContent = taglineText;
            }
        } else {
            document.getElementById('project-tagline').textContent = taglineText;
        }

        // Render Authors / Collaborators Row
        const authorsContainer = document.getElementById('project-authors-container');
        if (authorsContainer) {
            const collabs = p.collaborators || [];
            const activeCollabs = collabs.filter(c => c.status === 'active');
            const pendingCollabs = collabs.filter(c => c.status === 'invited');

            const namesList = [
                `<span style="color: white; font-weight: 600;">${this.escapeHtml(p.authorName || 'Trek Builder')}</span>`
            ];
            for (const c of activeCollabs) {
                namesList.push(`<span style="color: white; font-weight: 600;">${this.escapeHtml(c.display_name || c.slack_id || 'Teammate')}</span>`);
            }
            for (const c of pendingCollabs) {
                namesList.push(`<span style="opacity: 0.65;">${this.escapeHtml(c.display_name || c.slack_id || c.email)} <em style="font-size: 0.8em;">(Pending)</em></span>`);
            }

            authorsContainer.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 4px 12px 4px 6px;">
                    <div style="display: flex; align-items: center;">
                        <img src="${this.escapeHtml(p.authorAvatar || 'images/flag.png')}" alt="Owner" title="Owner: ${this.escapeHtml(p.authorName)}" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #ec3750; object-fit: cover; z-index: 5;">
                        ${activeCollabs.map((c, i) => `
                            <img src="${this.escapeHtml(c.avatar_url || 'images/flag.png')}" alt="Collab" title="${this.escapeHtml(c.display_name || c.slack_id)}" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #36C5F0; object-fit: cover; margin-left: -8px; z-index: ${4 - i};">
                        `).join('')}
                    </div>
                    <span style="font-size: 0.85rem; color: var(--hc-smoke);">
                        Project made by ${namesList.join(' & ')}
                    </span>
                </div>
            `;
        }

        document.getElementById('project-cover-img').src = this.resolveAsset(p.coverImageUrl || 'jet.png');

        // Status Pill
        const statusPill = document.getElementById('project-status-pill');
        if (statusPill) {
            statusPill.className = `status-pill status-${p.status}`;
            statusPill.textContent = p.status.replace('_', ' ').toUpperCase();
        }

        // Metrics
        document.getElementById('total-hours-val').textContent = `${p.totalHours}h`;
        document.getElementById('total-twigs-val').textContent = Math.round((p.totalHours || 0) * 25);
        document.getElementById('entry-count-val').textContent = p.journalEntries.length;

        // Review Button state
        const submitBtn = document.getElementById('submit-review-trigger-btn');
        if (submitBtn) {
            if (p.status === 'submitted') {
                submitBtn.textContent = 'Under Review';
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.6';
            } else if (p.status === 'approved') {
                submitBtn.textContent = 'Project Approved';
                submitBtn.disabled = true;
                submitBtn.style.background = '#33d6a6';
            } else {
                submitBtn.textContent = 'Submit for Review →';
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.background = 'var(--hc-red)';
            }
        }
    }

    renderReviewBanner() {
        const p = this.currentProject;
        const bannerContainer = document.getElementById('review-banner-container');
        if (!bannerContainer || !p) return;

        if (p.status === 'submitted') {
            bannerContainer.innerHTML = `
                <div class="review-banner banner-submitted">
                    <div class="review-banner-text">
                        <strong>Review Pending:</strong> Your project was submitted for review.
                        ${p.reviewFeedback ? `<br><span style="font-size: 0.88rem; opacity: 0.9;">"${p.reviewFeedback}"</span>` : ''}
                    </div>
                </div>
            `;
        } else if (p.status === 'approved') {
            bannerContainer.innerHTML = `
                <div class="review-banner banner-approved">
                    <div class="review-banner-text">
                        <strong>Project Approved:</strong> Congratulations, your build log passed reviewer verification.
                        ${p.reviewFeedback ? `<br><span style="font-size: 0.88rem; opacity: 0.9;">"${p.reviewFeedback}"</span>` : ''}
                    </div>
                </div>
            `;
        } else {
            bannerContainer.innerHTML = '';
        }
    }

    renderTimeline() {
        const timeline = document.getElementById('journal-timeline');
        if (!timeline || !this.currentProject) return;

        const entries = this.currentProject.journalEntries || [];

        if (entries.length === 0) {
            timeline.innerHTML = `
                <div style="text-align: center; padding: 48px 24px; color: var(--hc-muted); background: rgba(23, 23, 29, 0.4); border-radius: 12px; border: 1px dashed rgba(255,255,255,0.1);">
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--hc-white); margin-bottom: 4px;">No logs yet</div>
                    <div>Click <strong>"+ New Entry"</strong> to document your physical prototypes, 3D prints, or test flights.</div>
                </div>
            `;
            return;
        }

        timeline.innerHTML = entries.map(entry => {
            const formattedDate = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const renderedHtml = this.parseMarkdown(entry.content);

            const hasTeam = (this.currentProject.collaborators && this.currentProject.collaborators.length > 0);
            const authorTag = (entry.authorName && (hasTeam || entry.authorName !== this.currentProject.authorName))
                ? `<span style="color: #36C5F0; font-size: 0.82rem; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                     ${entry.authorAvatar ? `<img src="${this.escapeHtml(entry.authorAvatar)}" style="width: 16px; height: 16px; border-radius: 50%; object-fit: cover;">` : ''}
                     ${this.escapeHtml(entry.authorName)}
                   </span>`
                : '';

            return `
                <article class="journal-card" data-entry-id="${entry.id}">
                    <div class="entry-header">
                        <div>
                            <h3 class="entry-title">${this.escapeHtml(entry.title)}</h3>
                            <div class="entry-meta" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <span>${formattedDate}</span>
                                <span class="hours-tag">${entry.timeSpent} (${entry.timeHours}h)</span>
                                ${authorTag}
                            </div>
                        </div>
                    </div>
                    <div class="entry-body">${renderedHtml}</div>
                    <div class="entry-actions" style="margin-top: 12px; display: flex; gap: 8px;">
                        <button class="action-btn-sm edit-entry-btn" data-id="${entry.id}">Edit</button>
                        <button class="action-btn-sm btn-danger delete-entry-btn" data-id="${entry.id}">Delete</button>
                    </div>
                </article>
            `;
        }).join('');

        // Attach edit/delete event listeners
        timeline.querySelectorAll('.edit-entry-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const entry = this.currentProject.journalEntries.find(e => e.id === btn.dataset.id);
                if (entry) this.showInlineForm(entry);
            });
        });

        timeline.querySelectorAll('.delete-entry-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleDeleteEntry(btn.dataset.id));
        });
    }

    async openTeamModal() {
        const modal = document.getElementById('team-modal');
        const statusEl = document.getElementById('collab-invite-status');
        if (statusEl) statusEl.textContent = '';
        if (modal) modal.classList.add('active');
        await this.renderTeamMembers();
    }

    closeTeamModal() {
        document.getElementById('team-modal')?.classList.remove('active');
    }

    async renderTeamMembers() {
        const container = document.getElementById('team-members-list');
        if (!container) return;

        try {
            const collabs = await api.getCollaborators(this.currentProjectId);
            this.currentProject.collaborators = collabs;

            let html = `
                <!-- Project Owner -->
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <img src="${this.escapeHtml(this.currentProject.authorAvatar || 'images/flag.png')}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
                        <div>
                            <div style="font-weight: 600; color: white; font-size: 0.9rem;">${this.escapeHtml(this.currentProject.authorName || 'Project Creator')}</div>
                            <div style="font-size: 0.75rem; color: var(--hc-muted);">Project Owner</div>
                        </div>
                    </div>
                    <span style="font-size: 0.75rem; background: rgba(236, 55, 80, 0.2); color: var(--hc-red); border: 1px solid var(--hc-red); border-radius: 4px; padding: 2px 8px; font-weight: 700;">OWNER</span>
                </div>
            `;

            if (collabs.length === 0) {
                html += `
                    <div style="text-align: center; padding: 16px; color: var(--hc-muted); font-size: 0.85rem;">
                        No collaborators yet. Enter a teammate's Slack ID or email above to invite them!
                    </div>
                `;
            } else {
                html += collabs.map(c => {
                    const isPending = c.status === 'invited';
                    const name = c.display_name || c.slack_id || c.email || 'Teammate';
                    const avatar = c.avatar_url || 'images/flag.png';
                    const roleLabel = c.role === 'co_owner' ? 'Co-Owner' : 'Collaborator';

                    return `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <img src="${this.escapeHtml(avatar)}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; ${isPending ? 'opacity: 0.5;' : ''}">
                                <div>
                                    <div style="font-weight: 600; color: white; font-size: 0.9rem;">${this.escapeHtml(name)}</div>
                                    <div style="font-size: 0.75rem; color: var(--hc-muted);">
                                        ${roleLabel} ${isPending ? '• <span style="color: #ECB22E;">Pending Login</span>' : '• <span style="color: #33d6a6;">Active</span>'}
                                    </div>
                                </div>
                            </div>
                            <button type="button" class="remove-collab-btn" data-id="${c.id}" style="background: rgba(236,55,80,0.15); border: 1px solid rgba(236,55,80,0.3); color: #ff6b81; font-size: 0.75rem; font-weight: 600; padding: 4px 10px; border-radius: 6px; cursor: pointer;">Remove</button>
                        </div>
                    `;
                }).join('');
            }

            container.innerHTML = html;

            container.querySelectorAll('.remove-collab-btn').forEach(btn => {
                btn.addEventListener('click', () => this.handleRemoveCollab(btn.dataset.id));
            });

            await this.renderProjectHero();
        } catch (err) {
            container.innerHTML = `<div style="color: #ff6b81; font-size: 0.85rem;">Failed to load team: ${err.message}</div>`;
        }
    }

    async handleInviteCollabSubmit(e) {
        e.preventDefault();
        const input = document.getElementById('collab-identifier-input');
        const roleSelect = document.getElementById('collab-role-select');
        const submitBtn = document.getElementById('collab-submit-btn');
        const statusEl = document.getElementById('collab-invite-status');

        const identifier = input?.value.trim();
        const role = roleSelect?.value || 'collaborator';

        if (!identifier) return;

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Inviting...';
        }
        if (statusEl) statusEl.textContent = '';

        try {
            await api.inviteCollaborator(this.currentProjectId, identifier, role);
            if (input) input.value = '';
            if (statusEl) {
                statusEl.innerHTML = `<span style="color: #33d6a6;">✓ Teammate invited successfully!</span>`;
            }
            await this.renderTeamMembers();
        } catch (err) {
            if (statusEl) {
                statusEl.innerHTML = `<span style="color: #ff6b81;">Error: ${err.message}</span>`;
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Invite →';
            }
        }
    }

    async handleRemoveCollab(collabId) {
        if (!confirm('Remove this collaborator from the project?')) return;
        try {
            await api.removeCollaborator(this.currentProjectId, collabId);
            await this.renderTeamMembers();
        } catch (err) {
            alert(`Failed to remove: ${err.message}`);
        }
    }

    openReviewModal() {
        document.getElementById('review-modal')?.classList.add('active');
    }

    closeReviewModal() {
        document.getElementById('review-modal')?.classList.remove('active');
    }

    async handleDeleteEntry(entryId) {
        if (!confirm('Are you sure you want to delete this build log entry?')) return;
        try {
            const updated = await api.deleteJournalEntry(this.currentProjectId, entryId);
            if (updated) {
                this.currentProject = updated;
                await this.renderProjectHero();
                this.renderTimeline();
                this.renderReviewBanner();
            } else {
                await this.loadProject();
            }
        } catch (err) {
            alert(`Delete failed: ${err.message}`);
        }
    }

    async handleSubmitReview() {
        try {
            await api.submitProjectForReview(this.currentProjectId);
            this.closeReviewModal();
            await this.loadProject();
        } catch (err) {
            alert(`Submission error: ${err.message}`);
        }
    }

    parseMarkdown(md) {
        if (!md) return '';
        let text = md
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Fenced code blocks ```code```
        text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
            return `<pre class="code-block" style="background: rgba(18,18,23,0.9); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); overflow-x: auto; font-family: var(--hc-font-monospace); font-size: 0.88em; margin: 6px 0;"><code>${code.trim()}</code></pre>`;
        });

        // Inline code `code`
        text = text.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.08); padding: 2px 5px; border-radius: 4px; font-family: var(--hc-font-monospace); font-size: 0.88em;">$1</code>');

        // Blockquotes > text
        text = text.replace(/^&gt;\s+(.*$)/gim, '<blockquote style="border-left: 3px solid var(--hc-red); margin: 6px 0; padding: 4px 12px; color: var(--hc-smoke); background: rgba(255,255,255,0.02);">$1</blockquote>');

        // Horizontal rules
        text = text.replace(/^---$/gim, '<hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 12px 0;">');

        // Headers
        text = text.replace(/^#### (.*$)/gim, '<h5 style="color: var(--hc-white); margin: 10px 0 4px 0; font-size: 0.95rem; line-height: 1.2;">$1</h5>');
        text = text.replace(/^### (.*$)/gim, '<h4 style="color: var(--hc-white); margin: 12px 0 4px 0; font-size: 1.05rem; line-height: 1.2;">$1</h4>');
        text = text.replace(/^## (.*$)/gim, '<h3 style="color: var(--hc-white); margin: 14px 0 4px 0; font-size: 1.15rem; line-height: 1.2;">$1</h3>');
        text = text.replace(/^# (.*$)/gim, '<h2 style="color: var(--hc-white); margin: 16px 0 4px 0; font-size: 1.25rem; line-height: 1.2;">$1</h2>');

        // Images: ![alt](url) -> Clean Forge-style responsive image
        text = text.replace(/!\[(.*?)\]\((.*?)\)/gim, (match, alt, url) => {
            const cleanUrl = url ? url.trim() : '';
            if (!cleanUrl || cleanUrl.startsWith('Uploading')) {
                return `<div class="uploading-badge" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; background: rgba(255, 140, 55, 0.15); border: 1px dashed rgba(255, 140, 55, 0.4); color: #ff8c37; font-size: 0.85rem; margin: 8px 0;">⏳ Uploading image...</div>`;
            }
            const resolvedUrl = this.resolveAsset(cleanUrl);
            const cleanAlt = alt ? this.escapeHtml(alt) : 'Build Evidence';
            return `<img src="${resolvedUrl}" alt="${cleanAlt}" class="devlog-md-img" onclick="window.open('${resolvedUrl}', '_blank')">`;
        });

        // Links: [text](url)
        text = text.replace(/\[(.*?)\]\((.*?)\)/gim, '<a href="$2" target="_blank" rel="noopener" style="color: #5bc0de; text-decoration: underline;">$1</a>');

        // Bold & Italic & Strikethrough
        text = text.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
        text = text.replace(/\*(.*?)\*/gim, '<em>$1</em>');
        text = text.replace(/~~(.*?)~~/gim, '<del>$1</del>');

        // Unordered lists
        text = text.replace(/^\s*[\-\*]\s+(.*$)/gim, '<li style="margin-left: 14px; margin-bottom: 2px;">$1</li>');
        text = text.replace(/(<li.*<\/li>)/s, '<ul style="margin: 4px 0; padding-left: 8px;">$1</ul>');

        // Clean line breaks before & after block-level tags / images
        text = text.replace(/(<\/h[1-6]>)\s*(?:<br>|\n)+/gi, '$1');
        text = text.replace(/(<\/pre>)\s*(?:<br>|\n)+/gi, '$1');
        text = text.replace(/(<\/blockquote>)\s*(?:<br>|\n)+/gi, '$1');
        text = text.replace(/(<\/ul>)\s*(?:<br>|\n)+/gi, '$1');
        text = text.replace(/(<img[^>]*>)\s*(?:<br>|\n)+/gi, '$1');
        text = text.replace(/(?:<br>|\n)+(<img[^>]*>)/gi, '$1');

        // Paragraphs & Line Breaks
        text = text.replace(/\n\n+/g, '<div style="margin: 6px 0;"></div>');
        text = text.replace(/\n/g, '<br>');

        // Final cleanup of redundant <br> tags immediately following or preceding <img>
        text = text.replace(/<br>\s*(<img[^>]*>)/gi, '$1');
        text = text.replace(/(<img[^>]*>)\s*<br>/gi, '$1');

        return text;
    }

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

// Instantiate on load
document.addEventListener('DOMContentLoaded', () => {
    new TrekProjectController();
});
