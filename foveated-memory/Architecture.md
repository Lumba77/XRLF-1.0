### Architecture



Tools/foveated-memory/

├── package.json

├── server.js                    ← Main proxy (OpenAI-compatible, port 8200)

├── bin/foveated-memory.js       ← CLI entry point

├── core/

│   ├── xrl-compressor.js        ← 6-level gradient compression

│   ├── ring-builder.js          ← Builds the 6-ring foveated snapshot

│   ├── system-prompt-patch.js   ← Injects rings + ACTIVE RECALL instructions

│   └── recall-interceptor.js   ← Detects [recall:](recall:) in stream, orchestrates injection

├── memory/

│   └── store.js                 ← SQLite persistent store + TF-IDF semantic search

└── config/

&#x20;   └── default.json             ← All defaults, overridable via config.json or CLI





##### Howto use it after install

##### 

bash

\# With LM Studio running on :1234

node server.js

\# Then change LM Studio's "Local Server" client endpoint to:

http://localhost:8200

The model gets the ring block + recall instructions automatically in every request. Waiting for npm install to finish — will confirm it's clean and ready to run.





##### Install

npm install finished





##### Example config



✅ Tools/foveated-memory — Ready

🧠 Foveated Memory Proxy

&#x20;  Workspace : default (personal)

&#x20;  Upstream  : http://127.0.0.1:1234

&#x20;  Port      : 8200



✅ Listening on http://localhost:8200

&#x20;  → Point your client at: http://localhost:8200/v1/chat/completions



What's verified working:

✅ Pure JS install — 4 seconds, zero native compilation

✅ NeDB persistent memory store (file-based, per-workspace)

✅ 6-ring foveated block generated correctly from stored history

✅ [recall:](recall:) token detection in streams

✅ Memory store + TF-IDF semantic search

✅ Health endpoint, models passthrough

✅ Server starts cleanly and responds





##### To use it directly:



(LM Studio config)



powershell

\# In XRLF/Tools/foveated-memory/

node server.js



\# Then in LM Studio — change API endpoint to:

http://localhost:8200



Every model you load in LM Studio now gets the foveated ring block injected at session start and full [recall:](recall:) active memory on every turn. The workspace's memory persists permanently to ./memory\_data/default/memory.db


