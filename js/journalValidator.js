/**
 * Trek YSWS - Journal Entry Validator
 * 
 * Validates character count and image requirements for entries.
 */

export class TrekJournalValidator {
    static MIN_CONTENT_LENGTH = 80;

    /**
     * Validates if a journal entry meets quality standards
     * @param {string} content - Markdown content
     * @param {string[]} images - Attached image URLs
     * @returns {{ valid: boolean, errors: string[], details: Object }}
     */
    static validate(content = '', images = []) {
        const text = (content || '').toString();
        const textWithoutLinks = this.stripLinksAndTags(text);
        const hasMarkdownImage = this.hasImageInMarkdown(text);
        const hasAttachedImage = Array.isArray(images) && images.length > 0;
        const hasVisualEvidence = hasMarkdownImage || hasAttachedImage;

        const errors = [];
        if (textWithoutLinks.length < this.MIN_CONTENT_LENGTH) {
            errors.push(`Description must be at least ${this.MIN_CONTENT_LENGTH} characters (currently ${textWithoutLinks.length}).`);
        }

        if (!hasVisualEvidence) {
            errors.push('Entry must include at least one image!');
        }

        const details = {
            charCount: textWithoutLinks.length,
            minCharCount: this.MIN_CONTENT_LENGTH,
            hasVisualEvidence,
            meetsLengthRequirement: textWithoutLinks.length >= this.MIN_CONTENT_LENGTH,
            meetsImageRequirement: hasVisualEvidence,
            meetsAllRequirements: errors.length === 0
        };

        return {
            valid: errors.length === 0,
            errors,
            details
        };
    }

    /**
     * Checks if markdown string contains image syntax: ![alt](url) or <img>
     * @param {string} text
     * @returns {boolean}
     */
    static hasImageInMarkdown(text) {
        if (!text) return false;
        return (/!\[.*?\]\(.*?\)/.test(text)) || (/<img\s+[^>]*src=/i.test(text));
    }

    /**
     * Strips markdown links and HTML tags to calculate raw author word count
     * @param {string} text
     * @returns {string}
     */
    static stripLinksAndTags(text) {
        if (!text) return '';
        // Strip markdown images: ![alt](url) -> ""
        let cleaned = text.replace(/!\[.*?\]\(.*?\)/g, '');
        // Strip markdown links: [text](url) -> text
        cleaned = cleaned.replace(/\[(.*?)\]\(.*?\)/g, '$1');
        // Strip HTML tags
        cleaned = cleaned.replace(/<[^>]+>/g, '');
        // Normalize whitespace
        return cleaned.trim().replace(/\s+/g, ' ');
    }
}
