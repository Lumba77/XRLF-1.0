const fs = require('fs');
const path = require('path');
const { MemoryStore } = require('./memory/store');
const { v4: uuidv4 } = require('uuid');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node import_data.js <workspace_id> <path_to_file>");
    console.log("Example: node import_data.js jen ../../lessons.md");
    process.exit(1);
}

const workspaceId = args[0];
const filePath = path.resolve(args[1]);

if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
}

const store = new MemoryStore(path.resolve('./memory_data'), workspaceId);
const content = fs.readFileSync(filePath, 'utf8');

// Simple heuristic: split by double newlines to treat paragraphs as distinct memories
const paragraphs = content.split(/\n\s*\n/);
let imported = 0;
const sessionId = 'imported-' + uuidv4().slice(0, 8);

console.log(`\n🧠 Importing ${paragraphs.length} blocks into workspace [${workspaceId}]...`);

for (const p of paragraphs) {
    const text = p.trim();
    if (text.length > 10) { // Ignore tiny formatting lines
        // Store as a 'system' memory so it's treated as objective factual context
        store.store(sessionId, 'system', text, new Date().toISOString());
        imported++;
    }
}

setTimeout(() => {
    store.count().then(n => {
        console.log(`✅ Successfully imported ${imported} memories.`);
        console.log(`   Workspace [${workspaceId}] now holds ${n} total memories.`);
        process.exit(0);
    });
}, 1500); // Give SQLite a moment to flush
