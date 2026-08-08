/**
 * ═══════════════════════════════════════════════════════
 * MEMORY STORE — NeDB (pure JS) + Cosine Similarity Search
 * ═══════════════════════════════════════════════════════
 *
 * Persistent conversation memory with semantic search.
 * Uses NeDB (pure JavaScript, no native compilation) for storage
 * and TF-IDF cosine similarity for retrieval — zero native deps.
 *
 * Each workspace gets its own isolated .db file on disk.
 */

'use strict';

const Datastore = require('nedb-promises');
const path      = require('path');
const fs        = require('fs');

class MemoryStore {
    /**
     * @param {string} persistPath  - Directory to store .db files
     * @param {string} workspaceId  - Scopes all memory to this workspace
     */
    constructor(persistPath, workspaceId) {
        this.workspaceId = workspaceId || 'default';
        const dbDir = path.resolve(persistPath, workspaceId);
        fs.mkdirSync(dbDir, { recursive: true });

        this.db = Datastore.create({
            filename:   path.join(dbDir, 'memory.db'),
            autoload:   true,
            timestampData: true
        });

        this.themeDb = Datastore.create({
            filename:   path.join(dbDir, 'theme.db'),
            autoload:   true,
            timestampData: true
        });

        this.metaDb = Datastore.create({
            filename:   path.join(dbDir, 'session_meta.db'),
            autoload:   true,
            timestampData: true
        });

        this.tasksDb = Datastore.create({
            filename:   path.join(dbDir, 'session_tasks.db'),
            autoload:   true,
            timestampData: true
        });

        // Ensure indexes for fast queries
        this.db.ensureIndex({ fieldName: 'session_id' });
        this.db.ensureIndex({ fieldName: 'timestamp'  });
        this.themeDb.ensureIndex({ fieldName: 'theme_name' });
        this.themeDb.ensureIndex({ fieldName: 'category' });
        this.metaDb.ensureIndex({ fieldName: 'session_id', unique: true });
        this.tasksDb.ensureIndex({ fieldName: 'session_id', unique: true });
    }

    /**
     * Store a message turn to the persistent memory.
     * Now supports importance scoring and relational metadata.
     */
    async store(sessionId, role, content, timestamp, userId = 'anonymous', metadata = {}) {
        const ts = timestamp || new Date().toISOString();
        const doc = {
            session_id:  sessionId,
            role,
            content,
            timestamp:   ts,
            tokens_est:  Math.ceil(content.length / 4),
            user_id:     userId
        };

        // ── Importance & relational metadata ────────────────────────────
        if (metadata.importance) {
            doc.importance = {
                logic:      metadata.importance.logic || 3,
                emotional:  metadata.importance.emotional || 3,
                personal:   metadata.importance.personal || 3,
                actionable: metadata.importance.actionable || 3,
                overall:    metadata.importance.overall || 3,
                strategy:   metadata.importance.strategy || 'balanced',
                relationalBoost: metadata.importance._relationalBoost || 0
            };
        }
        if (metadata.categories && metadata.categories.length > 0) {
            doc.categories = metadata.categories;
        }
        if (metadata.topics && metadata.topics.length > 0) {
            doc.topics = metadata.topics;
        }
        if (metadata.tone) {
            doc.tone = metadata.tone;
        }

        const inserted = await this.db.insert(doc);
        return inserted;
    }

    /**
     * Get the N most recent messages (across all sessions).
     */
    async getRecent(n = 6) {
        const docs = await this.db
            .find({})
            .sort({ timestamp: -1 })
            .limit(n);
        return docs.reverse();
    }

    /**
     * Get the N most recent messages from a specific session.
     * Falls back to getRecent() if sessionId is not provided.
     */
    async getRecentBySession(sessionId, n = 6) {
        if (!sessionId) return this.getRecent(n);
        const docs = await this.db
            .find({ session_id: sessionId })
            .sort({ timestamp: -1 })
            .limit(n);
        return docs.reverse();
    }

    /**
     * Get messages from a specific session.
     */
    async getBySession(sessionId) {
        return this.db
            .find({ session_id: sessionId })
            .sort({ timestamp: 1 });
    }

    /**
     * Get messages by age bracket.
     * @param {number} daysMin  - Older than this many days
     * @param {number} daysMax  - Newer than this many days (0 = no bound)
     * @param {number} limit
     */
    async getByAge(daysMin, daysMax = 0, limit = 50) {
        const now    = Date.now();
        const minTs  = new Date(now - daysMin * 86400000).toISOString();
        const query  = daysMax === 0
            ? { timestamp: { $lt: minTs } }
            : { timestamp: { $lt: minTs, $gte: new Date(now - daysMax * 86400000).toISOString() } };

        return this.db
            .find(query)
            .sort({ timestamp: -1 })
            .limit(limit);
    }

    /**
     * Semantic search using TF-IDF cosine similarity (pure JS).
     * @param {string} query
     * @param {number} topN
     * @returns {Promise<Array<{message, score}>>}
     */
    async search(query, topN = 5) {
        const all = await this.db.find({});
        if (all.length === 0) return [];

        const queryTerms = this._tokenize(query);
        const scored = all.map(msg => ({
            message: msg,
            score:   this._cosineSimilarity(queryTerms, this._tokenize(msg.content))
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).filter(r => r.score > 0);
    }

    /**
     * Get total stored message count.
     */
    async count() {
        return this.db.count({});
    }

    /**
     * Get total consolidated theme count.
     */
    async countThemes() {
        return this.themeDb.count({});
    }

    /**
     * Get distinct session count.
     */
    async countSessions() {
        const all = await this.db.find({});
        const sessionIds = new Set(all.map(m => m.session_id).filter(Boolean));
        return sessionIds.size;
    }

    /**
     * Get list of distinct sessions with message counts, timestamps, and preview text.
     */
    async listSessions(limit = 10) {
        const all = await this.db.find({}).sort({ timestamp: -1 });
        const map = new Map();
        for (const msg of all) {
            const sId = msg.session_id || 'default';
            if (!map.has(sId)) {
                map.set(sId, {
                    session_id: sId,
                    count: 0,
                    last_updated: msg.timestamp,
                    preview: msg.content ? msg.content.slice(0, 60) : ''
                });
            }
            const item = map.get(sId);
            item.count += 1;
        }
        
        let sessions = Array.from(map.values())
            .filter(s => (s.count || 0) > 0 && typeof s.preview === 'string' && s.preview.trim().length > 0)
            .slice(0, limit);
        
        // Join with session metadata from metaDb
        const metaDocs = await this.metaDb.find({});
        const metaMap = new Map();
        for (const m of metaDocs) {
            if (m.session_id) metaMap.set(m.session_id, m);
        }
        
        for (const s of sessions) {
            if (metaMap.has(s.session_id)) {
                const meta = metaMap.get(s.session_id);
                if (meta.title) s.title = meta.title;
                if (meta.theme) s.theme = meta.theme;
                if (meta.project) s.project = meta.project;
                if (meta.keywords) s.keywords = meta.keywords;
                if (meta.ingredients) s.ingredients = meta.ingredients;
                if (meta.summary) s.summary = meta.summary;
            }
        }
        
        return sessions;
    }

    /**
     * Set AI-generated session metadata (title, dynamic theme, project)
     */
    async setSessionMeta(sessionId, metaObj) {
        await this.metaDb.update(
            { session_id: sessionId },
            { $set: { session_id: sessionId, ...metaObj, generated_at: new Date().toISOString() } },
            { upsert: true }
        );
    }
    
    async setSessionTitle(sessionId, title) {
        await this.setSessionMeta(sessionId, { title });
    }

    async deleteSession(sessionId) {
        await this.db.remove({ session_id: sessionId }, { multi: true });
        await this.metaDb.remove({ session_id: sessionId }, { multi: true });
        await this.tasksDb.remove({ session_id: sessionId }, { multi: true });
    }

    /**
     * Save the active task board state for a session.
     */
    async saveTasks(sessionId, tasks) {
        await this.tasksDb.update(
            { session_id: sessionId },
            { $set: { session_id: sessionId, tasks: tasks, updated_at: new Date().toISOString() } },
            { upsert: true }
        );
    }

    /**
     * Retrieve the active task board state for a session.
     */
    async getTasks(sessionId) {
        const doc = await this.tasksDb.findOne({ session_id: sessionId });
        return doc ? doc.tasks : [];
    }

    /**
     * Store or update a consolidated Theme document.
     */
    async storeTheme(themeObj) {
        const ts = themeObj.timestamp || new Date().toISOString();
        const doc = {
            theme_name:  themeObj.theme_name || 'General Workspace Context',
            category:    themeObj.category || 'General',
            summary:     themeObj.summary || '',
            decisions:   themeObj.decisions || [],
            code_refs:   themeObj.code_refs || [],
            session_ids: themeObj.session_ids || [],
            raw_count:   themeObj.raw_count || 1,
            timestamp:   ts,
            tokens_est:  Math.ceil((themeObj.summary || '').length / 4)
        };

        const existing = await this.themeDb.findOne({ theme_name: doc.theme_name });
        if (existing) {
            await this.themeDb.update({ _id: existing._id }, { $set: doc });
            return existing._id;
        } else {
            const res = await this.themeDb.insert(doc);
            return res._id;
        }
    }

    /**
     * Semantic search across Consolidated Theme documents.
     */
    async searchThemes(query, topN = 5) {
        const all = await this.themeDb.find({});
        if (all.length === 0) return [];

        const queryTerms = this._tokenize(query);
        const scored = all.map(theme => {
            const searchableText = `${theme.theme_name} ${theme.category} ${theme.summary} ${theme.decisions.join(' ')}`;
            return {
                theme,
                score: this._cosineSimilarity(queryTerms, this._tokenize(searchableText))
            };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).filter(r => r.score > 0);
    }

    /**
     * Consolidate raw messages into Theme blocks.
     * Clusters messages by session and extracts thematic topics.
     */
    async consolidateRawMemories() {
        const allRaw = await this.db.find({});
        if (allRaw.length === 0) return { themesCreated: 0, rawProcessed: 0 };

        // Group raw messages by session_id
        const sessions = {};
        for (const msg of allRaw) {
            const sId = msg.session_id || 'default_session';
            if (!sessions[sId]) sessions[sId] = [];
            sessions[sId].push(msg);
        }

        let themesCreated = 0;

        for (const [sId, msgs] of Object.entries(sessions)) {
            // Sort by timestamp
            msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Extract topic markers or build session summary
            const codeFiles = new Set();
            const highlights = [];
            let textAcc = '';

            for (const m of msgs) {
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                textAcc += content + '\n';

                // Extract file paths referenced
                const files = content.match(/([A-Za-z]:[\\/][^\s,\u201c\u201d"']+|[a-zA-Z0-9_/-]+\.(?:py|ts|js|json|md|html|css)\b)/g);
                if (files) files.forEach(f => codeFiles.add(f));

                // Extract decisions/highlights
                if (/TODO|FIX|IMPORTANT|SOLVED|PLAN|REFACTOR/i.test(content)) {
                    highlights.push(content.slice(0, 150).replace(/\n/g, ' ').trim());
                }
            }

            // Derive Theme Name
            let themeName = `Session ${sId.replace('sess_', '')}`;
            if (codeFiles.size > 0) {
                const topFile = Array.from(codeFiles)[0].split(/[\\/]/).pop();
                themeName = `Development on ${topFile}`;
            }

            const summary = textAcc.slice(0, 800).trim();

            await this.storeTheme({
                theme_name:  themeName,
                category:    codeFiles.size > 0 ? 'Development' : 'Conversation',
                summary:     summary,
                decisions:   highlights.slice(0, 5),
                code_refs:   Array.from(codeFiles).slice(0, 8),
                session_ids: [sId],
                raw_count:   msgs.length,
                timestamp:   msgs[msgs.length - 1]?.timestamp || new Date().toISOString()
            });

            themesCreated++;
        }

        return { themesCreated, rawProcessed: allRaw.length };
    }

    /**
     * Clear all memory from this workspace.
     */
    async clearAll() {
        return this.db.remove({}, { multi: true });
    }

    /**
     * Remove specific memory by ID.
     */
    async removeById(id) {
        return this.db.remove({ _id: id }, {});
    }

    // ── Private helpers ────────────────────────────────────────────────────

    _tokenize(text) {
        const stopWords = new Set([
            'the','a','an','is','it','in','on','at','to','of','and','or',
            'for','with','this','that','was','are','','as','we','','you',
            'havehad','do','not','but','so','if','by','can','will'
        ]);
        const freqs = {};
        // Normalize array content (OpenAI multi-part format) to string
        const normalized = Array.isArray(text)
            ? text.filter(p => p && typeof p === 'object' && typeof p.text === 'string').map(p => p.text).join('\n')
            : String(text || '');
        const words = normalized.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
        for (const w of words) {
            if (w.length > 2 && !stopWords.has(w)) {
                freqs[w] = (freqs[w] || 0) + 1;
            }
        }
        return freqs;
    }

    _cosineSimilarity(a, b) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        let dot = 0, magA = 0, magB = 0;
        for (const k of keys) {
            const va = a[k] || 0;
            const vb = b[k] || 0;
            dot  += va * vb;
            magA += va * va;
            magB += vb * vb;
        }
        if (magA === 0 || magB === 0) return 0;
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }
}

module.exports = { MemoryStore };
