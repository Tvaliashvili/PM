// =============================================================
// Site photos - shrunk in the browser, kept in Supabase Storage
//
// A site phone writes 3-5 MB per shot (108 MP in high-res mode). Nothing in a
// progress record needs that, so every photo is resized twice before it leaves
// the phone: one 1280 px copy for the report, one 400 px thumbnail for lists.
// A day's photos then cost about as much as a single original.
// =============================================================

export const PHOTO_BUCKET = 'site-photos';
export const MAX_PHOTOS = 12;

const FULL = { px: 1280, quality: 0.72 };
const THUMB = { px: 400, quality: 0.6 };
const SIGNED_FOR = 60 * 60; // seconds a signed link stays valid

/** Longest side down to `px`, re-encoded as JPEG. Smaller photos are left alone. */
async function shrink(file, { px, quality }) {
  // 'from-image' applies the phone's rotation flag, so portrait shots stay upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, px / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('The photo could not be read.');
  return blob;
}

const ownerColumn = (owner) => (owner.dailyLogId ? 'daily_log_id' : 'delay_id');
const ownerId = (owner) => owner.dailyLogId ?? owner.delayId;

/**
 * Uploads `files` against one daily log or one delay. Returns the number stored;
 * throws with a readable message if the bucket or the table refuses.
 */
export async function uploadPhotos(db, { projectId, files, ...owner }) {
  const id = ownerId(owner);
  if (!id || !files.length) return 0;
  const store = db.storage.from(PHOTO_BUCKET);
  const rows = [];

  for (const file of files) {
    const key = `${projectId}/${id}/${crypto.randomUUID()}`;
    const [full, thumb] = await Promise.all([shrink(file, FULL), shrink(file, THUMB)]);
    const paths = { path: `${key}.jpg`, thumb_path: `${key}_t.jpg` };
    const up = await Promise.all([
      store.upload(paths.path, full, { contentType: 'image/jpeg' }),
      store.upload(paths.thumb_path, thumb, { contentType: 'image/jpeg' }),
    ]);
    const failed = up.find((r) => r.error);
    if (failed) throw new Error(failed.error.message);
    rows.push({ project_id: projectId, [ownerColumn(owner)]: id, ...paths, bytes: full.size });
  }

  const { error } = await db.from('photos').insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
}

/** Every photo belonging to the given daily logs / delays, oldest first. */
export async function fetchPhotos(db, { dailyLogIds = [], delayIds = [] }) {
  if (!dailyLogIds.length && !delayIds.length) return [];
  const filters = [];
  if (dailyLogIds.length) filters.push(`daily_log_id.in.(${dailyLogIds.join(',')})`);
  if (delayIds.length) filters.push(`delay_id.in.(${delayIds.join(',')})`);
  const { data, error } = await db
    .from('photos')
    .select('id, daily_log_id, delay_id, path, thumb_path, created_at')
    .or(filters.join(','))
    .order('created_at');
  if (error) return [];
  return data;
}

/**
 * Signed links for `photos`, as a Map of photo id → url. The bucket is private,
 * so nothing is readable without one. `full` asks for the 1280 px copy.
 */
export async function signPhotos(db, photos, { full = false } = {}) {
  const urls = new Map();
  if (!photos.length) return urls;
  const paths = photos.map((p) => (full ? p.path : p.thumb_path));
  const { data, error } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGNED_FOR);
  if (error) return urls;
  data.forEach((row, i) => { if (row.signedUrl) urls.set(photos[i].id, row.signedUrl); });
  return urls;
}

/** Groups photos by the log or delay they belong to. */
export function photosBy(photos, key) {
  const map = new Map();
  for (const p of photos) {
    const owner = p[key];
    if (!owner) continue;
    if (!map.has(owner)) map.set(owner, []);
    map.get(owner).push(p);
  }
  return map;
}

/**
 * Clears the files of a daily log or a delay before the row itself goes. The
 * rows cascade with their owner, but the stored files would be left behind.
 */
export async function deletePhotosFor(db, owner) {
  const photos = await fetchPhotos(db, owner.dailyLogId
    ? { dailyLogIds: [owner.dailyLogId] }
    : { delayIds: [owner.delayId] });
  if (!photos.length) return;
  await db.storage.from(PHOTO_BUCKET).remove(photos.flatMap((p) => [p.path, p.thumb_path]));
}

/** Removes one photo: both files, then the row. */
export async function deletePhoto(db, photo) {
  await db.storage.from(PHOTO_BUCKET).remove([photo.path, photo.thumb_path]);
  const { error } = await db.from('photos').delete().eq('id', photo.id);
  if (error) throw new Error(error.message);
}
