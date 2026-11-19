import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { HttpError } from "./http.js";

// These two packages are CommonJS and ship their own typings in different
// shapes, so load them with require instead of fighting ESM interop.
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const ffprobePath = (require("ffprobe-static") as { path: string }).path;

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB, before compression
export const VIDEO_MAX_SECONDS = 30;

// A clip a phone calls "30 seconds" is often 30.03. Don't reject it.
const DURATION_TOLERANCE_SECONDS = 0.5;

const IMAGE_MAX_EDGE = 1600;
// Rejects decompression bombs: a tiny file that expands to a huge bitmap.
const IMAGE_MAX_INPUT_PIXELS = 50_000_000;
const THUMB_SIZE = 480;
const VIDEO_MAX_HEIGHT = 720;

// Encoding is CPU heavy and runs inside the API process, so only a couple at
// a time. Anyone else gets a clear "try again" instead of a slow server.
const MAX_CONCURRENT_VIDEOS = 2;
const FFMPEG_TIMEOUT_MS = 90_000;
const FFPROBE_TIMEOUT_MS = 20_000;

// Only real container formats are accepted. Playlists, concat scripts and
// plain text files report other format names and are refused.
// MP4/MOV report "mov,mp4,m4a,3gp,3g2,mj2"; WebM reports "matroska,webm".
const ALLOWED_VIDEO_FORMATS = new Set(["mov", "mp4", "matroska", "webm"]);

// Formats sharp is allowed to decode for photos. Keeps SVG and other odd
// types out even if the browser called them image/*.
const ALLOWED_IMAGE_FORMATS = new Set([
    "jpeg",
    "png",
    "webp",
    "heif",
    "avif",
    "gif",
]);

let activeVideoJobs = 0;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ProcessedMedia = {
    type: "image" | "video";
    contentType: string;
    body: Buffer;
    thumb: Buffer;
    width: number;
    height: number;
    durationSeconds: number | null;
};

type UploadedFile = { path: string; mimetype: string; size: number };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Runs a program with an argument array (never through a shell) and kills it
// if it takes too long.
function run(
    command: string,
    args: string[],
    timeoutMs: number
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        // Only the tail matters when something fails.
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-2000);
        });

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });

        child.on("close", (code) => {
            clearTimeout(timer);

            if (code === 0) {
                resolve(stdout);
                return;
            }

            reject(new Error(`${command} exited with ${code}: ${stderr}`));
        });
    });
}

type VideoInfo = { width: number; height: number; duration: number | null };

type ProbeOutput = {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string; format_name?: string };
};

// A user-supplied file can be a crafted playlist that points ffmpeg at other
// files or at network addresses. Allowing only the "file" protocol closes
// the network side; the format allowlist in probeVideo closes the rest.
const SAFE_INPUT = ["-protocol_whitelist", "file"];

// When `checkFormat` is true the container must be on the allowlist. It is
// only needed for the user's upload: our own re-encoded output is always MP4.
async function probeVideo(
    path: string,
    checkFormat: boolean
): Promise<VideoInfo> {
    let parsed: ProbeOutput;

    try {
        const raw = await run(
            ffprobePath,
            [
                "-v",
                "error",
                ...SAFE_INPUT,
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height:format=duration,format_name",
                "-of",
                "json",
                path,
            ],
            FFPROBE_TIMEOUT_MS
        );

        parsed = JSON.parse(raw) as ProbeOutput;
    } catch {
        throw new HttpError(400, "That file isn't a valid video");
    }

    if (checkFormat) {
        const formats = (parsed.format?.format_name ?? "").split(",");

        if (!formats.some((name) => ALLOWED_VIDEO_FORMATS.has(name))) {
            throw new HttpError(400, "That file isn't a valid video");
        }
    }

    const stream = parsed.streams?.[0];

    // Audio-only and unreadable files have no video stream.
    if (!stream?.width || !stream.height) {
        throw new HttpError(400, "That file isn't a valid video");
    }

    // Some recordings (browser WebM, for one) have no duration in the header.
    const duration = Number(parsed.format?.duration);

    return {
        width: stream.width,
        height: stream.height,
        duration: Number.isFinite(duration) ? duration : null,
    };
}

async function makeThumb(input: Buffer | string): Promise<Buffer> {
    return sharp(input)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover" })
        .webp({ quality: 75 })
        .toBuffer();
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

// Decodes the file (so non-images fail here, whatever the client claimed),
// applies the EXIF rotation, limits the size and re-encodes as WebP. sharp
// drops all metadata, including GPS location, unless asked to keep it.
async function processImage(path: string): Promise<ProcessedMedia> {
    try {
        const metadata = await sharp(path, {
            limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
        }).metadata();

        if (!metadata.format || !ALLOWED_IMAGE_FORMATS.has(metadata.format)) {
            throw new Error(`Unsupported image format: ${metadata.format}`);
        }

        const { data, info } = await sharp(path, {
            limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
        })
            .rotate()
            .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, {
                fit: "inside",
                withoutEnlargement: true,
            })
            .webp({ quality: 82 })
            .toBuffer({ resolveWithObject: true });

        return {
            type: "image",
            contentType: "image/webp",
            body: data,
            thumb: await makeThumb(data),
            width: info.width,
            height: info.height,
            durationSeconds: null,
        };
    } catch {
        throw new HttpError(400, "That file isn't a valid image");
    }
}

/* ------------------------------------------------------------------ */
/* Videos                                                              */
/* ------------------------------------------------------------------ */

function tooLong() {
    return new HttpError(
        400,
        `Videos can be up to ${VIDEO_MAX_SECONDS} seconds`
    );
}

// Checks the length, then re-encodes to a small H.264/AAC MP4 that plays in
// every browser, drops all metadata (location included) and takes a frame
// for the thumbnail.
async function processVideo(inputPath: string): Promise<ProcessedMedia> {
    if (!ffmpegPath) {
        console.error("ffmpeg-static has no binary for this platform");
        throw new HttpError(503, "Video uploads are not available");
    }

    const maxDuration = VIDEO_MAX_SECONDS + DURATION_TOLERANCE_SECONDS;
    const source = await probeVideo(inputPath, true);

    // The cheap check: refuse before spending any CPU.
    if (source.duration !== null && source.duration > maxDuration) {
        throw tooLong();
    }

    if (activeVideoJobs >= MAX_CONCURRENT_VIDEOS) {
        throw new HttpError(
            503,
            "Video uploads are busy right now. Try again in a minute."
        );
    }

    activeVideoJobs += 1;
    let workDir: string | null = null;

    try {
        workDir = await mkdtemp(join(tmpdir(), "sync-video-"));

        const outputPath = join(workDir, "out.mp4");

        try {
            await run(
                ffmpegPath,
                [
                    "-y",
                    "-loglevel",
                    "error",
                    ...SAFE_INPUT,
                    "-i",
                    inputPath,
                    // One second over the limit: a longer clip is rejected
                    // below rather than silently trimmed, and a file with no
                    // duration in its header can't keep us encoding for minutes.
                    "-t",
                    String(VIDEO_MAX_SECONDS + 1),
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    // Even dimensions are required by H.264 with yuv420p.
                    "-vf",
                    `scale=-2:'trunc(min(${VIDEO_MAX_HEIGHT},ih)/2)*2'`,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "28",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    "-map_metadata",
                    "-1",
                    "-movflags",
                    "+faststart",
                    outputPath,
                ],
                FFMPEG_TIMEOUT_MS
            );
        } catch (error) {
            console.error("Video encode failed:", error);
            throw new HttpError(
                400,
                "That video couldn't be processed. Try an MP4 or MOV file."
            );
        }

        // The output length is the real one, whatever the header claimed.
        const output = await probeVideo(outputPath, false);
        const duration = output.duration ?? 0;

        if (duration > maxDuration) {
            throw tooLong();
        }

        const framePath = join(workDir, "frame.png");

        try {
            await run(
                ffmpegPath,
                [
                    "-y",
                    "-loglevel",
                    "error",
                    "-ss",
                    Math.min(1, duration / 2).toFixed(2),
                    "-i",
                    outputPath,
                    "-frames:v",
                    "1",
                    framePath,
                ],
                FFPROBE_TIMEOUT_MS
            );
        } catch (error) {
            console.error("Video thumbnail failed:", error);
            throw new HttpError(
                400,
                "That video couldn't be processed. Try an MP4 or MOV file."
            );
        }

        return {
            type: "video",
            contentType: "video/mp4",
            body: await readFile(outputPath),
            thumb: await makeThumb(framePath),
            width: output.width,
            height: output.height,
            durationSeconds: Math.max(1, Math.round(duration)),
        };
    } finally {
        activeVideoJobs -= 1;

        if (workDir) {
            await rm(workDir, { recursive: true, force: true });
        }
    }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// The browser's claimed type only picks the path. Each path decodes the file
// itself, so a renamed file of the wrong kind fails with a 400 here.
export async function processUpload(
    file: UploadedFile
): Promise<ProcessedMedia> {
    if (file.mimetype.startsWith("image/")) {
        if (file.size > IMAGE_MAX_BYTES) {
            throw new HttpError(413, "Photos must be 10 MB or smaller");
        }

        return processImage(file.path);
    }

    if (file.mimetype.startsWith("video/")) {
        return processVideo(file.path);
    }

    throw new HttpError(400, "Choose a photo or a video");
}