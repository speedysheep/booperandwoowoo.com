// Processes every video in public/videos/ and publishes it to R2:
//   - a poster JPG (first frame) into public/thumbs/ — committed to git, just like photo thumbs
//   - a tiny muted hover-preview clip, uploaded to R2 under previews/<hash>.mp4
//   - the full video (re-encoded to H.264 + downscaled if it's HEVC / large / high-bitrate),
//     uploaded to R2 under videos/<hash>.mp4
// Entries are merged into public/gallery.json (type: "video"), alongside whatever
// scripts/generate-thumbnails.mjs already wrote for photos.
//
// Run with: node scripts/process-videos.mjs (or `npm run gallery` to also do photos).
// Safe to re-run: unchanged source videos are skipped via .media-cache.json.
//
// Requires: `npx wrangler login` once, with access to the booperandwoowoo-media R2 bucket.
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const publicDir = path.join(repoRoot, "public");
const videosDir = path.join(publicDir, "videos");
const thumbsDir = path.join(publicDir, "thumbs");
const manifestPath = path.join(publicDir, "gallery.json");
const cachePath = path.join(repoRoot, ".media-cache.json");
const stagingDir = path.join(repoRoot, ".video-staging");
// Videos that fail to probe/encode are moved here (sibling of the repo, never committed).
const invalidDir = path.join(repoRoot, "..", "invalid_videos");

const R2_BUCKET = "booperandwoowoo-media";
const R2_PUBLIC_BASE_URL = "https://media.booperandwoowoo.com";

const MAX_LONG_EDGE = 1280; // re-encode target for the full video
const REENCODE_BITRATE_THRESHOLD = 4_000_000; // bps; above this we re-encode even if already H.264
const PREVIEW_LONG_EDGE = 640;
const PREVIEW_DURATION = 3; // seconds

const isVideo = (name) => /\.(mp4|mov|m4v)$/i.test(name);

async function sha1File(filePath) {
	const hash = createHash("sha1");
	await new Promise((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", resolve);
		stream.on("error", reject);
	});
	return hash.digest("hex");
}

async function probe(filePath) {
	const { stdout } = await execFileAsync(ffprobeStatic.path, [
		"-v",
		"error",
		"-show_entries",
		"stream=codec_type,codec_name,width,height,bit_rate",
		"-show_entries",
		"format=duration,bit_rate",
		"-of",
		"json",
		filePath,
	]);
	const data = JSON.parse(stdout);
	const video = data.streams?.find((s) => s.codec_type === "video");
	const audio = data.streams?.find((s) => s.codec_type === "audio");
	if (!video || !video.width || !video.height) {
		throw new Error("no usable video stream");
	}
	return {
		width: video.width,
		height: video.height,
		codec: video.codec_name,
		bitRate: Number(video.bit_rate || data.format?.bit_rate || 0),
		duration: Number(data.format?.duration || 0),
		hasAudio: Boolean(audio),
	};
}

function scaledDims(width, height, longEdge) {
	if (Math.max(width, height) <= longEdge) {
		return { width: evenify(width), height: evenify(height) };
	}
	if (width >= height) {
		return { width: longEdge, height: evenify(Math.round((height * longEdge) / width)) };
	}
	return { width: evenify(Math.round((width * longEdge) / height)), height: longEdge };
}

const evenify = (n) => (n % 2 === 0 ? n : n - 1);

function needsReencode(info) {
	return (
		info.codec !== "h264" ||
		Math.max(info.width, info.height) > MAX_LONG_EDGE ||
		info.bitRate > REENCODE_BITRATE_THRESHOLD
	);
}

async function run(args, label) {
	try {
		await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });
	} catch (err) {
		throw new Error(`${label} failed: ${err.stderr?.slice(-2000) || err.message}`);
	}
}

async function makeFullVideo(srcPath, outPath, info) {
	if (!needsReencode(info)) {
		await execFileAsync(ffmpegPath, ["-y", "-i", srcPath, "-c", "copy", "-movflags", "+faststart", outPath]);
		return;
	}
	const { width, height } = scaledDims(info.width, info.height, MAX_LONG_EDGE);
	const args = [
		"-y",
		"-i",
		srcPath,
		"-vf",
		`scale=${width}:${height}`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"26",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
	];
	if (info.hasAudio) {
		args.push("-c:a", "aac", "-b:a", "128k");
	} else {
		args.push("-an");
	}
	args.push(outPath);
	await run(args, "full video re-encode");
}

async function makePreviewClip(srcPath, outPath, info) {
	const { width, height } = scaledDims(info.width, info.height, PREVIEW_LONG_EDGE);
	const start = Math.min(1, info.duration * 0.1);
	const clipLength = Math.min(PREVIEW_DURATION, Math.max(info.duration - start, 0.5));
	await run(
		[
			"-y",
			"-ss",
			String(start),
			"-i",
			srcPath,
			"-t",
			String(clipLength),
			"-vf",
			`scale=${width}:${height}`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"30",
			"-pix_fmt",
			"yuv420p",
			"-an",
			"-movflags",
			"+faststart",
			outPath,
		],
		"preview clip encode",
	);
}

async function makePoster(srcPath, outJpgPath, info) {
	const framePath = path.join(stagingDir, `poster-${path.basename(outJpgPath)}.raw.jpg`);
	const at = Math.min(1, info.duration / 2);
	await run(["-y", "-ss", String(at), "-i", srcPath, "-frames:v", "1", "-q:v", "2", framePath], "poster extraction");
	await sharp(framePath).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(outJpgPath);
	await rm(framePath, { force: true });
}

const wranglerEntry = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

async function uploadToR2(localPath, key, contentType) {
	await execFileAsync(process.execPath, [
		wranglerEntry,
		"r2",
		"object",
		"put",
		`${R2_BUCKET}/${key}`,
		"--file",
		localPath,
		"--content-type",
		contentType,
		"--cache-control",
		"public, max-age=31536000, immutable",
		"--remote",
	]);
}

async function loadCache() {
	try {
		return JSON.parse(await readFile(cachePath, "utf8"));
	} catch {
		return {};
	}
}

async function loadExistingManifest() {
	try {
		return JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		return [];
	}
}

async function quarantine(name, reason) {
	await mkdir(invalidDir, { recursive: true });
	console.warn(`  ! ${name}: ${reason} -- moving to ${invalidDir}`);
	try {
		await rename(path.join(videosDir, name), path.join(invalidDir, name));
	} catch (err) {
		console.warn(`    (couldn't move it: ${err.message}; leaving it in public/videos/)`);
	}
}

async function main() {
	await mkdir(videosDir, { recursive: true });
	await mkdir(thumbsDir, { recursive: true });
	await mkdir(stagingDir, { recursive: true });

	const entries = await readdir(videosDir, { withFileTypes: true });
	const videos = entries
		.filter((e) => e.isFile() && isVideo(e.name))
		.map((e) => e.name)
		.sort();

	console.log(`Found ${videos.length} videos.`);

	const cache = await loadCache();
	const manifestEntries = [];

	for (const name of videos) {
		const srcPath = path.join(videosDir, name);
		console.log(`\n${name}`);

		let info;
		try {
			info = await probe(srcPath);
		} catch (err) {
			await quarantine(name, `couldn't read it (${err.message})`);
			continue;
		}

		const srcStat = await stat(srcPath);
		const cacheKey = name;
		const cached = cache[cacheKey];

		if (cached && cached.size === srcStat.size && cached.mtimeMs === srcStat.mtimeMs) {
			console.log("  unchanged, skipping re-encode/upload");
			manifestEntries.push(cached.entry);
			continue;
		}

		let hash;
		try {
			hash = await sha1File(srcPath);
		} catch (err) {
			await quarantine(name, `couldn't hash it (${err.message})`);
			continue;
		}

		const posterName = name.replace(/\.(mp4|mov|m4v)$/i, ".jpg");
		const posterPath = path.join(thumbsDir, posterName);
		const fullStagePath = path.join(stagingDir, `full-${hash}.mp4`);
		const previewStagePath = path.join(stagingDir, `preview-${hash}.mp4`);

		try {
			console.log("  extracting poster frame...");
			await makePoster(srcPath, posterPath, info);

			console.log("  encoding preview clip...");
			await makePreviewClip(srcPath, previewStagePath, info);

			console.log(needsReencode(info) ? "  re-encoding full video (H.264, capped at 1280px)..." : "  full video already web-friendly, copying...");
			await makeFullVideo(srcPath, fullStagePath, info);
		} catch (err) {
			await quarantine(name, err.message);
			continue;
		}

		const videoKey = `videos/${hash}.mp4`;
		const previewKey = `previews/${hash}.mp4`;

		console.log("  uploading to R2...");
		await uploadToR2(fullStagePath, videoKey, "video/mp4");
		await uploadToR2(previewStagePath, previewKey, "video/mp4");

		await rm(fullStagePath, { force: true });
		await rm(previewStagePath, { force: true });

		const finalDims = needsReencode(info) ? scaledDims(info.width, info.height, MAX_LONG_EDGE) : { width: info.width, height: info.height };

		const entry = {
			type: "video",
			poster: `thumbs/${posterName}`,
			preview: `${R2_PUBLIC_BASE_URL}/${previewKey}`,
			full: `${R2_PUBLIC_BASE_URL}/${videoKey}`,
			width: finalDims.width,
			height: finalDims.height,
			duration: info.duration,
		};
		manifestEntries.push(entry);
		cache[cacheKey] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs, entry };
		await writeFile(cachePath, JSON.stringify(cache, null, 2));

		console.log(`  done -> ${entry.full}`);
	}

	const existing = await loadExistingManifest();
	const photoEntries = existing.filter((e) => e.type === "photo" || !e.type);

	await writeFile(manifestPath, JSON.stringify([...photoEntries, ...manifestEntries], null, 2));
	console.log(`\nWrote ${manifestEntries.length} video entries to public/gallery.json`);

	await rm(stagingDir, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
