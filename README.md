# Earthsync: Phase 1, Chat messages (full version)

Branch: `feat/chat-full`
Last updated: 2026-11-23

This file records what was decided, what is built, and what is left in the
first phase of the safety and chat work. It is a working note, not product
documentation.

---

## 1. Roadmap and branches

| Order | Phase | Branch |
|---|---|---|
| 1 | Chat messages: images, voice notes, encryption, retention | `feat/chat-full` (this phase) |
| 2 | Block, unblock, masked threads | `feat/block-and-mask` |
| 3 | Reports, admin queue, appeals, grievance and takedown pages | `feat/reports` |
| 4 | 1v1 audio and video calls | `feat/calls` |
| 5 | Feed | `feat/feed` |

Rules for branches: create each phase from an up-to-date `main`, merge it back
when the phase is finished, never merge half-finished work. `feat/chat-full` is
currently stacked on `feat/age-gate`, which is not merged into `main` yet.

---

## 2. Decisions made

**Encryption model**
- Provider-side encryption, not end-to-end. The server can decrypt, and does so
  only under rules in code (participants reading their thread, report handling).
- Text: encrypted by the app with AES-256-GCM. The nonce is stored in front of
  the ciphertext in `body_enc`; `key_version` allows key rotation. The AAD binds
  each ciphertext to `conversationId:senderId`.
- Files: rely on R2 encryption at rest. Per-file app keys can come later.
- Keys live in environment variables or a secret manager, never in the repo.
  Reports will use a separate key so access to chats is not access to evidence.
- The privacy policy must say messages are encrypted at rest but can be
  reviewed when reported.

**What a message can contain**
- Text, one image, or one voice note. No video in chat for now (storage and
  transcoding cost). The design leaves room to add it later.
- Images: resized to 1600px, WebP, 5 MB cap, EXIF and GPS stripped on the server.
- Voice notes: up to 60 seconds, duration verified server-side with ffprobe,
  converted to mono AAC (`.m4a`, 64 kbps) so it plays in every browser.

**Who can send what**
- Text: anyone who is not blocked.
- Photos and voice notes: **friends only**, enforced on the server.
  The check runs early (before any processing) and again inside the save
  transaction under a row lock on the friendship.
- After an unfriend, old photos and voice notes **stay visible**. Sending needs
  friendship at send time; viewing needs only being a participant and not blocked.

**Evidence and reports (built in a later phase, designed now)**
- `media.sha256` is stored at upload so a later evidence copy can be shown to
  match what was sent.
- `conversations.retention_hold` stops the retention job from deleting a
  reported thread.
- A report always points at a specific thing (message, post, comment, account,
  later a call) and the person responsible. Report copies are made server-side
  into a separate, restricted store with their own key.
- Never auto-remove content from a report count. Auto-hide only for the most
  severe categories (for example "involves a minor") until an admin reviews.
- Reporters stay anonymous to the reported person. Every admin view is logged.
  Affected people get an appeal route. Law-enforcement requests follow a
  documented process with a log of what was disclosed.

**Storage and cost**
- Chat files go in their own private R2 bucket (`R2_CHAT_BUCKET`, prefix
  `chat/`), served only through signed URLs after the access checks.
- The retention window caps storage cost, so the retention job must delete the
  R2 objects, not only database rows.

---

## 3. How the code is laid out (relevant parts)

- `backend/`: Express, Drizzle, Postgres (Neon), `ws` for sockets, R2 via the S3
  SDK, sharp and ffmpeg for media.
- `SoloMusic/`: Vite, React, shadcn (Base UI flavor) frontend.
- Text goes over REST (`POST /api/messages`) and the WebSocket. Attachments
  cannot go over the socket (16 KB frame cap), so they use REST multipart.
- `announceMessage` in `lib/socket.ts` needs no change: it builds payloads from
  `sent.media`, which `sendAttachment` fills with signed URLs.

---

## 4. Done

**Pushed and read on the branch**
- `lib/crypto.ts`: AES-GCM helper with key versions.
- Migration `0012_chat_messages_media.sql`, snapshot and journal, and matching
  `schema.ts`: `message_kind` enum, `audio` media type, nullable `body`,
  `body_enc`, `key_version`, `media_id`, `messages_content` and
  `messages_enc_has_version` checks, `media.sha256`, `conversations.retention_hold`.
- `lib/chat.ts`: text encrypted on send; `readMessageText`, `serializeMessage`,
  `chatMessageFromSent`, `previewText`.
- `routes/chat.ts`: inbox and history decrypt through those helpers; inbox shows
  "Photo" and "Voice message" labels.
- `db/encrypt-messages.ts`: one-off backfill that encrypts old plaintext rows.
- `lib/chat-media.ts`: `processChatImage` and `processVoice` with limits, format
  allowlist, concurrency cap and SHA-256.
- Stray text fixed in `0011_dob_rules.sql`.

**Written in this session, to be applied, compiled and tested**
- Migration `0013` (change `messages.media_id` foreign key from `RESTRICT` to
  `NO ACTION`, so deleting a user cascades cleanly) and the one-line
  `schema.ts` change that goes with it.
- `lib/r2.ts`: chat bucket helpers (`createChatKeys`, `putChatObject`,
  `signChatUrl`, `deleteChatObjects`).
- `lib/chat.ts`: `buildChatMedia`, `assertCanSendAttachment`, `sendAttachment`.
- `routes/chat-attachments.ts` (new): `POST /api/messages/attachment`, multipart
  with `file`, `username`, `kind` (`image` or `voice`), rate limited, friends only.
- `routes/chat.ts`: history joins `media`, signs URLs after the access checks,
  and returns `isFriend`.
- `app.ts`: import and mount of the attachments router.

---

## 5. Left to do in this phase

1. **Apply and verify the backend above.** Push migration 0013, run it, compile.
2. **Frontend** (`SoloMusic`): nothing for chat attachments exists yet.
   - `chat-thread.tsx`: attach-photo button, record-voice button (MediaRecorder,
     60 s cap), image bubble, audio player, upload progress and failure states.
   - Hide attach and mic when `isFriend` is false.
   - Extend the `Item` and `ChatMessage` types with `kind` and `media`.
   - Upload via `fetch` multipart to `/api/messages/attachment`; merge the
     response by id (the socket event for the same message is deduped).
   - Refetch quietly when signed URLs expire (30 to 45 minutes).
   - `conversation-row.tsx`: show the attachment preview label.
3. **Retention job.** Delete messages older than the retention window together
   with their `media` rows and R2 objects (via `deleteChatObjects`), skip
   conversations with `retention_hold`, and run it on a schedule. Also sweep
   orphaned files left by deleted accounts.
4. **Run the backfill** (`db/encrypt-messages.ts`) and confirm old messages
   still show.
5. **Drop `messages.body`** in a later migration once nothing reads it, then
   simplify `readMessageText`.

---

## 6. Environment variables for this phase

```
CHAT_ENC_KEY_1=<32 random bytes, base64>
CHAT_ENC_KEY_VERSION=1
R2_CHAT_BUCKET=<private bucket name>
```

Back the encryption key up in a password manager. If it is lost, encrypted
messages cannot be read. The R2 API token must have access to the chat bucket.

---

## 7. Test checklist

- A new text message saves with `body` null, `body_enc` filled, `key_version` 1,
  and still displays.
- Old messages display before and after the backfill.
- Image upload to a friend returns 201 with `media.url`; the `media` row has
  `sha256` and `status = ready`; the file is in the chat bucket.
- The same upload to a non-friend returns 403 before any processing.
- A voice note over 60 seconds, or a non-audio file, is rejected.
- History returns `media` for attachments and `isFriend`.
- Deleting a user who has a chat image succeeds (checks the 0013 change).
- `.env` is not tracked by git.

---

## 8. Later phases (summary)

- **Block and mask:** block and unblock routes (one transaction that removes the
  friendship, requests and likes, and must lock-order with `sendAttachment`),
  masked identity in inbox, thread header and socket payloads, a neutral socket
  event, a Settings page with the blocked list. Blocked people must still be
  able to report a message in a masked thread.
- **Reports:** `reports` and evidence tables, reason tree served from the API,
  per-type snapshots with hashes and legal hold, report dialog everywhere
  something can be reported, severe-category auto-hide (needs a moderation
  status on posts), admin queue with access log, appeals, grievance and
  takedown pages, then a block audit with real rows.
- **Calls:** WebRTC 1v1. Reports about calls carry metadata only. No recording
  at MVP. Blocking must prevent calls.
- **Feed:** staged: chronological from friends, then a simple score
  (recency x engagement x affinity), then learned signals. Log events
  (impressions, likes, hides, reports) from day one.

---

## 9. Open decisions

- Retention window length.
- Scheduler for the retention job (in-process timer, a cron library, or an
  external cron hitting a protected route).
- When to merge `feat/age-gate` and `feat/chat-full` into `main`.
- Legal review before launch: mandatory reporting duties involving minors,
  unlawful-speech rules per jurisdiction, and the grievance and takedown process.
