/* SillyTavern server plugin: read-only filesystem timestamps for user's presets.
 * No user-supplied file paths are accepted; uses request.user.directories.
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DIRECTORIES = Object.freeze({
    openai: 'openAI_Settings',
    kobold: 'koboldAI_Settings',
    novel: 'novelAI_Settings',
    textgenerationwebui: 'textGen_Settings',
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
});

async function getGroup(folder) {
    const output = Object.create(null);
    if (typeof folder !== 'string' || !folder) return output;
    let dirents;
    try {
        dirents = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return output;
        throw error;
    }
    await Promise.all(dirents.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json')).map(async entry => {
        const fullPath = path.join(folder, entry.name);
        try {
            const stat = await fs.stat(fullPath);
            const reliableBirth = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0;
            const effectiveDate = reliableBirth ? stat.birthtime : stat.mtime;
            output[path.parse(entry.name).name] = {
                createdAt: effectiveDate.toISOString(),
                modifiedAt: stat.mtime.toISOString(),
                source: reliableBirth ? 'created' : 'modified',
            };
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('[Preset Date Manager] Could not stat preset file:', error.message);
        }
    }));
    return output;
}

async function init(router) {
    router.get('/dates', async (request, response) => {
        const directories = request.user?.directories;
        if (!directories) return response.sendStatus(401);
        try {
            const groups = {};
            await Promise.all(Object.entries(DIRECTORIES).map(async ([api, folderKey]) => {
                groups[api] = await getGroup(directories[folderKey]);
            }));
            // Prevent metadata from being cached, especially after import/rename.
            response.setHeader('Cache-Control', 'private, no-store');
            response.json({ groups });
        } catch (error) {
            console.error('[Preset Date Manager] Dates error', error);
            response.sendStatus(500);
        }
    });
    console.log('[Preset Date Manager] Timestamp endpoint active');
}

module.exports = {
    init,
    info: {
        id: 'preset-date-manager',
        name: 'Preset Date Manager (Dates)',
        description: 'Read-only preset creation timestamps for the UI extension.',
    },
};
