# METI AI Community Assistant

A WhatsApp assistant for the UniPods METI AI Innovation Programme community. It reads what is actually shared in the groups (messages, announcements, official documents and session recordings), builds a searchable memory from it, and answers members' questions accurately without inventing anything.

Built for the UniPods Chatbot Hackathon: process the community's group data and answer members' questions directly, so important information is never lost.

## Features

- **Grounded question answering** in groups and private chats, based only on real programme content.
- **Hybrid memory search** combining full-text search (SQLite FTS5, BM25) with multilingual semantic vectors, fused with Reciprocal Rank Fusion.
- **Automatic knowledge curation**: raw group messages are distilled into clean, de-duplicated facts (extract / update / no-op pipeline).
- **Document handling**: PDFs and images are OCR'd and indexed; official documents can be sent on request in English or French.
- **Session ingestion**: recording links are transcribed and turned into detailed facts, so members who missed a session can still get the content.
- **Deterministic scheduling**: dates, deadlines, reminders and the daily/weekly recap are computed in code; the model only phrases them.
- **Multilingual**: replies in the same language the member used (English / French).
- **Resilient LLM layer**: OpenAI-compatible client with automatic failover to a secondary provider.

## Architecture

```
WhatsApp (Baileys)
      │
   bot.js                      orchestration: routing, DMs, group answers, owner commands, watcher
      ├── src/brain.js         prompt building + answer modes (group / DM / recaps)
      ├── src/memory.js        SQLite + FTS5 + vector table, hybrid search (RRF)
      ├── src/llm.js           OpenAI-compatible client with multi-endpoint failover
      ├── src/schedule.js      deterministic events, reminders and alerts
      ├── src/calendar.js      day-by-day calendar with admin overrides
      ├── src/transcribe.js    recording/voice-note transcription -> facts
      ├── src/docs.js          sendable document registry (EN/FR)
      └── src/*.js             plugins: meetings, emojis, mentions, links, media, ...
   curator.js                  background loop turning group logs into curated facts
   embed-service.py            Flask micro-service serving multilingual embeddings
```

## Tech stack

- Node.js, [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp
- `better-sqlite3` with FTS5 for memory and full-text search
- Python (Flask + `fastembed`) for multilingual embeddings
- Any OpenAI-compatible LLM endpoint

## Setup

### Prerequisites

- Node.js 20+
- Python 3.10+ (for the embeddings micro-service)
- A WhatsApp account for the bot
- An OpenAI-compatible LLM endpoint and API key

### 1. Install dependencies

```bash
npm install
python -m venv .venv && . .venv/bin/activate
pip install flask fastembed numpy
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env` with your LLM credentials, the bot phone number and your group ids. Every value is documented in `.env.example`.

### 3. Start the embeddings micro-service

```bash
python embed-service.py      # serves on 127.0.0.1:7867
```

If the service is unavailable the bot automatically falls back to full-text search only, so this step is optional but recommended.

### 4. Run the bot

```bash
node --env-file=.env bot.js
```

On first launch the bot prints a pairing code. On your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number, then enter the code. Authentication is stored locally under `auth/` (git-ignored).

### 5. Run the curator (optional, recommended)

The curator continuously turns group logs into clean facts:

```bash
node --env-file=.env curator.js
```

### Production (PM2)

```bash
cp ecosystem.config.example.js ecosystem.config.js   # then edit paths
pm2 start ecosystem.config.js
```

## Configuration notes

- No secrets, phone numbers, group ids or meeting links are hardcoded. Everything sensitive is read from environment variables (see `.env.example`).
- Runtime state (memory database, logs, authentication, uploaded media) lives in git-ignored folders and never leaves the machine.

## Owner commands (private message)

Send these to the bot from an owner number (`OWNER_JIDS`): `/status`, `/pause`, `/resume`, `/docs`, `/cal`, `/say`, `/send`, `/help`.

## License

MIT
