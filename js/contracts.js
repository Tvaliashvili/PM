// =============================================================
// Contracts with contractors - the signed PDFs, for the administrator alone
// Each contract can carry its acceptance acts (მიღება-ჩაბარების აქტი), the
// PDFs certifying each interim payment: rows with contract_id set.
//
// Kept beside the site photos in Cloudflare R2, under contracts/<project>/,
// with a row each in contract_files saying whose contract it is. Nobody but
// the administrator can list them (the table's policy) or open one (photo-url
// signs no contracts/ link for anyone else). They are never in a report.
// =============================================================
import { signedUrls } from './photos.js';

export const MAX_CONTRACT_MB = 25;

/** Every contract and act on the project, newest signed first. */
export async function fetchContracts(db, projectId) {
  const { data, error } = await db.from('contract_files')
    .select('id, contractor_id, contract_id, title, act_no, amount, signed_on, path, file_name, bytes, created_at')
    .eq('project_id', projectId)
    .order('signed_on', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Uploads one PDF against a contractor, then records it: a contract, or with
 * `contractId` an act under that contract, with its number and amount.
 */
export async function uploadContract(db, {
  projectId, contractorId, file, title, signedOn, contractId = null, actNo = null, amount = null,
}) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error('Only a PDF can be uploaded.');
  if (file.size > MAX_CONTRACT_MB * 1024 * 1024) throw new Error(`The file is over ${MAX_CONTRACT_MB} MB.`);
  const path = `contracts/${projectId}/${crypto.randomUUID()}.pdf`;
  const [url] = await signedUrls(db, [path], 'PUT');
  if (!url) throw new Error('File storage did not answer.');
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
  if (!res.ok) throw new Error(`Upload refused (${res.status})`);
  const { error } = await db.from('contract_files').insert({
    project_id: projectId,
    contractor_id: contractorId,
    contract_id: contractId,
    act_no: actNo || null,
    amount: amount ?? null,
    title: title || (actNo ? `Act № ${actNo}` : file.name.replace(/\.pdf$/i, '')),
    signed_on: signedOn || null,
    path,
    file_name: file.name,
    bytes: file.size,
  });
  if (error) {
    await removeFiles(db, [path]).catch(() => {}); // don't leave a file nothing points at
    throw new Error(error.message);
  }
}

/** A link to read one contract, good for an hour. */
export async function contractUrl(db, contract) {
  const [url] = await signedUrls(db, [contract.path], 'GET');
  if (!url) throw new Error('File storage did not answer.');
  return url;
}

async function removeFiles(db, paths) {
  if (!paths.length) return;
  const urls = await signedUrls(db, paths, 'DELETE');
  const results = await Promise.all(urls.map((url) => fetch(url, { method: 'DELETE' })));
  // R2 answers 204 for a file removed, and also for one that was already gone.
  if (results.some((r) => !r.ok)) throw new Error('A contract file could not be removed from storage');
}

/** Removes contracts or acts: their files, then their rows. Pass a contract's acts with it. */
export async function deleteContracts(db, contracts) {
  if (!contracts.length) return;
  await removeFiles(db, contracts.map((c) => c.path));
  const { error } = await db.from('contract_files').delete().in('id', contracts.map((c) => c.id));
  if (error) throw new Error(error.message);
}

/** Every contract file of a project, before the project goes (its rows go with it, the files would not). */
export async function deleteProjectContracts(db, projectId) {
  const { data, error } = await db.from('contract_files').select('path').eq('project_id', projectId);
  if (error) throw new Error(error.message);
  await removeFiles(db, data.map((c) => c.path));
}
