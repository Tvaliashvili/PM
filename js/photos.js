// =============================================================
// Site photos - shrunk in the browser, kept in Cloudflare R2
//
// A site phone writes 3-5 MB per shot (108 MP in high-res mode). Nothing in a
// progress record needs that, so every photo is resized twice before it leaves
// the phone: one 1280 px copy for the report, one 400 px thumbnail for lists.
// A day's photos then cost about as much as a single original.
//
// The bytes live in R2 (10 GB free, and no charge for reading them back); the
// photos table in Supabase holds what each one belongs to. The bucket is
// private - the photo-url Edge Function signs every link, so the R2 keys never
// reach the browser.
// =============================================================

export const MAX_PHOTOS = 24;
const URL_FUNCTION = 'photo-url';

const FULL = { px: 1280, quality: 0.72 };
const THUMB = { px: 400, quality: 0.6 };

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

/**
 * Signed R2 links for `paths`, in the same order. `method` is what the link may
 * be used for: GET to read, PUT to upload, DELETE to remove.
 */
// The function signs at most this many paths a request (see photo-url).
const PATHS_PER_REQUEST = 48;

export async function signedUrls(db, paths, method = 'GET') {
  if (!paths.length) return [];
  const batches = [];
  for (let i = 0; i < paths.length; i += PATHS_PER_REQUEST) batches.push(paths.slice(i, i + PATHS_PER_REQUEST));
  const signed = await Promise.all(batches.map(async (batch) => {
    const { data, error } = await db.functions.invoke(URL_FUNCTION, { body: { paths: batch, method } });
    if (error) {
      let message = error.message;
      try {
        const body = await error.context?.json();
        if (body?.error) message = body.error;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }
    return data.urls ?? [];
  }));
  return signed.flat();
}

const ownerColumn = (owner) => (owner.dailyLogId ? 'daily_log_id' : 'delay_id');
const ownerId = (owner) => owner.dailyLogId ?? owner.delayId;

/**
 * Uploads `files` against one daily log or one delay. Returns the number stored;
 * throws with a readable message if R2 or the table refuses.
 */
export async function uploadPhotos(db, { projectId, files, ...owner }) {
  const id = ownerId(owner);
  if (!id || !files.length) return 0;

  // Shrink everything first, so one round trip covers every upload link.
  const parts = [];
  for (const file of files) {
    const key = `${projectId}/${id}/${crypto.randomUUID()}`;
    const [full, thumb] = await Promise.all([shrink(file, FULL), shrink(file, THUMB)]);
    parts.push({ path: `${key}.jpg`, thumb_path: `${key}_t.jpg`, full, thumb });
  }

  const paths = parts.flatMap((p) => [p.path, p.thumb_path]);
  const urls = await signedUrls(db, paths, 'PUT');
  if (urls.length !== paths.length) throw new Error('Photo storage did not answer.');

  const blobs = parts.flatMap((p) => [p.full, p.thumb]);
  const results = await Promise.all(urls.map((url, i) => fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blobs[i],
  })));
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(`Upload refused (${failed.status})`);

  const rows = parts.map((p) => ({
    project_id: projectId,
    [ownerColumn(owner)]: id,
    path: p.path,
    thumb_path: p.thumb_path,
    bytes: p.full.size,
  }));
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
 *
 * A failure here leaves thumbnails blank rather than stopping the page, so it
 * returns what it has instead of throwing.
 */
export async function signPhotos(db, photos, { full = false } = {}) {
  const urls = new Map();
  if (!photos.length) return urls;
  try {
    const signed = await signedUrls(db, photos.map((p) => (full ? p.path : p.thumb_path)));
    signed.forEach((url, i) => { if (url) urls.set(photos[i].id, url); });
  } catch { /* the page still renders, without the pictures */ }
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

/** Removes the files behind `photos` from R2. The rows are somebody else's job. */
async function removeFiles(db, photos) {
  if (!photos.length) return;
  const paths = photos.flatMap((p) => [p.path, p.thumb_path]);
  const urls = await signedUrls(db, paths, 'DELETE');
  await Promise.all(urls.map((url) => fetch(url, { method: 'DELETE' })));
}

/**
 * Clears the files of a daily log or a delay before the row itself goes. The
 * rows cascade with their owner, but the stored files would be left behind.
 */
export async function deletePhotosFor(db, owner) {
  const photos = await fetchPhotos(db, owner.dailyLogId
    ? { dailyLogIds: [owner.dailyLogId] }
    : { delayIds: [owner.delayId] });
  await removeFiles(db, photos);
}

/**
 * Clears every photo file of a project before the project itself goes - its
 * rows cascade with it, but the files would stay in storage with nothing
 * pointing at them. Throws if they could not be removed, so the project is
 * kept and the delete can be tried again.
 */
export async function deleteProjectPhotos(db, projectId) {
  const { data, error } = await db.from('photos').select('path, thumb_path').eq('project_id', projectId);
  if (error) throw new Error(error.message);
  if (!data.length) return;
  const paths = data.flatMap((p) => [p.path, p.thumb_path]);
  const urls = await signedUrls(db, paths, 'DELETE');
  const results = await Promise.all(urls.map((url) => fetch(url, { method: 'DELETE' })));
  // R2 answers 204 for a file removed, and also for one that was already gone.
  if (results.some((r) => !r.ok)) throw new Error('Some photos could not be removed from storage');
}

/** Removes one photo: both files, then the row. */
export async function deletePhoto(db, photo) {
  await removeFiles(db, [photo]);
  const { error } = await db.from('photos').delete().eq('id', photo.id);
  if (error) throw new Error(error.message);
}
