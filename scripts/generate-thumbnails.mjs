// Generates gallery thumbnails for every photo in public/pictures/.
// Run with: node scripts/generate-thumbnails.mjs (or `npm run gallery` to also process videos)
// Re-run any time you add new photos to public/pictures/ before deploying.
import sharp from "sharp";
import { readdir, mkdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const picturesDir = path.join(publicDir, "pictures");
const thumbsDir = path.join(publicDir, "thumbs");
const manifestPath = path.join(publicDir, "gallery.json");

const THUMB_WIDTH = 480; // ~2x a 240px grid cell, for retina screens
const THUMB_QUALITY = 78;

const isPhoto = (name) => /\.(jpe?g|png|webp)$/i.test(name);

async function loadExistingManifest() {
	try {
		return JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		return [];
	}
}

async function main() {
	await mkdir(picturesDir, { recursive: true });
	await mkdir(thumbsDir, { recursive: true });

	const entries = await readdir(picturesDir, { withFileTypes: true });
	const photos = entries
		.filter((e) => e.isFile() && isPhoto(e.name))
		.map((e) => e.name)
		.sort();

	console.log(`Found ${photos.length} photos.`);

	const manifest = [];

	for (const name of photos) {
		const srcPath = path.join(picturesDir, name);
		const thumbName = name.replace(/\.(jpe?g|png|webp)$/i, ".jpg");
		const thumbPath = path.join(thumbsDir, thumbName);

		const image = sharp(srcPath).rotate(); // rotate() auto-applies EXIF orientation
		const meta = await image.metadata();

		const srcStat = await stat(srcPath);
		let thumbStat;
		try {
			thumbStat = await stat(thumbPath);
		} catch {
			thumbStat = null;
		}

		if (thumbStat && thumbStat.mtimeMs >= srcStat.mtimeMs) {
			console.log(`  ${name} -> thumbs/${thumbName} (up to date, skipped)`);
		} else {
			await image
				.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
				.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
				.toFile(thumbPath);
			thumbStat = await stat(thumbPath);
			console.log(
				`  ${name} (${(srcStat.size / 1024).toFixed(0)} KB) -> thumbs/${thumbName} (${(thumbStat.size / 1024).toFixed(0)} KB)`,
			);
		}

		manifest.push({
			type: "photo",
			full: `pictures/${name}`,
			thumb: `thumbs/${thumbName}`,
			width: meta.width,
			height: meta.height,
		});
	}

	// Preserve any video entries a previous `npm run videos` run already wrote,
	// so running this script alone doesn't drop them from the gallery.
	const existing = await loadExistingManifest();
	const videoEntries = existing.filter((e) => e.type === "video");

	await writeFile(manifestPath, JSON.stringify([...manifest, ...videoEntries], null, 2));
	console.log(`\nWrote ${manifest.length} photo entries to public/gallery.json`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
