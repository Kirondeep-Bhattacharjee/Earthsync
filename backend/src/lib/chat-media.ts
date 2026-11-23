import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./http.js";
import {
    ffmpegPath,
    ffprobePath,
    processImage,
    run,
    SAFE_INPUT,
    type UploadedFile,
} from "./post-media.js";

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const VOICE_MAX_BYTES = 3 * 1024 * 1024; // 3 MB, before conversion
export const VOICE_MAX_SECONDS = 60;
const VOICE_MIN_SECONDS = 1;

// A recording a phone calls "60 seconds" is often 60.03. Don't reject it.
const DURATION_TOLERANCE_SECONDS = 0.5;

// Encoding runs inside the API process, so only a couple at a time.
const MAX_CONCURRENT_VOICE = 2;
const FFMPEG_TIMEOUT_MS = 30_000;
const FFPROBE_TIMEOUT_MS = 20_000;

// What browsers record: Chrome/Edge WebM, Firefox Ogg, Safari MP4. MP4 reports
// "mov,mp4,m4a,3gp,3g2,mj2" and WebM reports "matroska,webm". Playlists, concat
// scripts and text files report other names and are refused.
const ALLOWED_AUDIO_FORMATS = new Set([
    "matroska",
    "webm",
    "mov",
    "mp4",
    "ogg",
    "mp3",
    "wav",
]);

let activeVoiceJobs = 0;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

// What the route stores: the file, an optional thumbnail, and its hash.
export type ProcessedChatMedia = {
    type: "image" | "audio";
    contentType: string;
    body: Buffer;
    thumb: Buffer | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    sha256: string; // of `body`, the bytes that are stored
};

function sha256(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

// Same pipeline as posts (decode, rotate, resize to 1600px, WebP, strip
// metadata, thumbnail) with a smaller size limit.
export async function processChatImage(
    file: UploadedFile
): Promise<ProcessedChatMedia> {
    if (!file.mimetype.startsWith("image/")) {
        throw new HttpError(400, "Choose a photo");
    }

    if (file.size > CHAT_IMAGE_MAX_BYTES) {
        throw new HttpError(413, "Photos must be 5 MB or smaller");
    }

    const processed = await processImage(file.path);

    return {
        type: "image",
        contentType: processed.contentType,
        body: processed.body,
        thumb: processed.thumb,
        width: processed.width,
        height: processed.height,
        durationSeconds: null,
        sha256: sha256(processed.body),
    };
}

/* ------------------------------------------------------------------ */
/* Voice notes                                                         */
/* ------------------------------------------------------------------ */

type AudioProbe = { duration: number | null };

type ProbeOutput = {
    streams?: { codec_type?: string }[];
    format?: { duration?: string; format_name?: string };
};

function notAudio() {
    return new HttpError(400, "That file isn't a valid voice recording");
}

function tooLong() {
    return new HttpError(
        400,
        `Voice messages can be up to ${VOICE_MAX_SECONDS} seconds`
    );
}

async function probeAudio(
    path: string,
    checkFormat: boolean
): Promise<AudioProbe> {
    let parsed: ProbeOutput;

    try {
        const raw = await run(
            ffprobePath,
            [
                "-v",
                "error",
                ...SAFE_INPUT,
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type:format=duration,format_name",
                "-of",
                "json",
                path,
            ],
            FFPROBE_TIMEOUT_MS
        );

        parsed = JSON.parse(raw) as ProbeOutput;
    } catch {
        throw notAudio();
    }

    if (checkFormat) {
        const formats = (parsed.format?.format_name ?? "").split(",");

        if (!formats.some((name) => ALLOWED_AUDIO_FORMATS.has(name))) {
            throw notAudio();
        }
    }

    // No audio stream means it isn't a recording at all.
    if (parsed.streams?.[0]?.codec_type !== "audio") {
        throw notAudio();
    }

    // Browser recordings (WebM, Ogg) often have no duration in the header.
    const duration = Number(parsed.format?.duration);

    return { duration: Number.isFinite(duration) ? duration : null };
}

// Checks the length, then converts to mono AAC in an .m4a file, which plays in
// every browser whatever the recording format was. Drops all metadata.
export async function processVoice(
    file: UploadedFile
): Promise<ProcessedChatMedia> {
    if (!file.mimetype.startsWith("audio/")) {
        throw notAudio();
    }

    if (file.size > VOICE_MAX_BYTES) {
        throw new HttpError(413, "That recording is too large");
    }

    if (!ffmpegPath) {
        console.error("ffmpeg-static has no binary for this platform");
        throw new HttpError(503, "Voice messages are not available");
    }

    const maxDuration = VOICE_MAX_SECONDS + DURATION_TOLERANCE_SECONDS;
    const source = await probeAudio(file.path, true);

    // The cheap check: refuse before spending any CPU.
    if (source.duration !== null && source.duration > maxDuration) {
        throw tooLong();
    }

    if (activeVoiceJobs >= MAX_CONCURRENT_VOICE) {
        throw new HttpError(
            503,
            "Voice messages are busy right now. Try again in a moment."
        );
    }

    activeVoiceJobs += 1;
    let workDir: string | null = null;

    try {
        workDir = await mkdtemp(join(tmpdir(), "sync-voice-"));

        const outputPath = join(workDir, "out.m4a");

        try {
            await run(
                ffmpegPath,
                [
                    "-y",
                    "-loglevel",
                    "error",
                    ...SAFE_INPUT,
                    "-i",
                    file.path,
                    // One second over the limit: a longer recording is rejected
                    // below rather than silently trimmed, and a file with no
                    // duration in its header can't keep us encoding.
                    "-t",
                    String(VOICE_MAX_SECONDS + 1),
                    "-vn",
                    "-map",
                    "0:a:0",
                    "-ac",
                    "1",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "64k",
                    "-map_metadata",
                    "-1",
                    "-movflags",
                    "+faststart",
                    outputPath,
                ],
                FFMPEG_TIMEOUT_MS
            );
        } catch (error) {
            console.error("Voice encode failed:", error);
            throw notAudio();
        }

        // The output length is the real one, whatever the header claimed.
        const output = await probeAudio(outputPath, false);
        const duration = output.duration ?? 0;

        if (duration > maxDuration) {
            throw tooLong();
        }

        if (duration < VOICE_MIN_SECONDS) {
            throw new HttpError(400, "That recording is too short");
        }

        const body = await readFile(outputPath);

        return {
            type: "audio",
            contentType: "audio/mp4",
            body,
            thumb: null,
            width: null,
            height: null,
            durationSeconds: Math.max(1, Math.round(duration)),
            sha256: sha256(body),
        };
    } finally {
        activeVoiceJobs -= 1;

        if (workDir) {
            await rm(workDir, { recursive: true, force: true });
        }
    }
}