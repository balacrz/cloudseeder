// utils/permset.mjs
import JSZipPkg from 'jszip';
const JSZip = JSZipPkg;

const API_VERSION = '60.0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function sanitizePsName(name) {
  let s = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(s)) s = 'PS_' + s;
  if (s.length > 40) s = s.slice(0, 40);
  return s;
}

export async function ensurePermissionSetExists(conn, { name, label, log = console }) {
  const fullName = sanitizePsName(name);
  const read = await conn.metadata.read('PermissionSet', [fullName]);
  const ps = Array.isArray(read) ? read[0] : read;
  if (ps?.fullName) return fullName;

  const createRes = await conn.metadata.create('PermissionSet', {
    fullName,
    label: label || fullName,
    hasActivationRequired: false
  });
  const cr = Array.isArray(createRes) ? createRes[0] : createRes;
  if (cr && String(cr.success) === 'true') {
    log.info(`[Permissionset] Created via metadata.create: ${fullName}`);
    return fullName;
  }

  log.warn(`[Permissionset] metadata.create failed for ${fullName}. Falling back to deploy…`);

  const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>${fullName}</members><name>PermissionSet</name></types>
  <version>${API_VERSION}</version>
</Package>`;
  const psXml = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <hasActivationRequired>false</hasActivationRequired>
  <label>${(label || fullName).replace(/&/g, '&amp;')}</label>
</PermissionSet>`;

  const zip = new JSZip();
  zip.file('package.xml', pkgXml);
  zip.file(`permissionsets/${fullName}.permissionset-meta.xml`, psXml);
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

  const deploy = await conn.metadata.deploy(zipBuf, { checkOnly: false, singlePackage: true });
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await conn.metadata.checkDeployStatus(deploy.id, true);
    if (st.done === 'true') {
      if (st.status !== 'Succeeded') {
        const fails = arr(st.details?.componentFailures)
          .map(f => `${f.componentType}.${f.fullName}: ${f.problem}`).join(' | ');
        throw new Error(`[Permissionset] Deploy failed: ${fails || st.errorMessage || st.status}`);
      }
      log.info(`[Permissionset] Created via deploy: ${fullName}`);
      return fullName;
    }
  }
  throw new Error(`[Permissionset] Timeout waiting for Permission Set deploy: ${fullName}`);
}

export async function upsertFieldPermissions(conn, { permissionSetName, entries, log = console }) {
  if (!permissionSetName) throw new Error('permissionSetName is required.');
  if (!entries?.length) return;

  const psName = sanitizePsName(permissionSetName);
  const read = await conn.metadata.read('PermissionSet', [psName]);
  const ps = Array.isArray(read) ? read[0] : read;
  if (!ps?.fullName) throw new Error(`[Permissionset] Not found: ${psName}. Call ensurePermissionSetExists first.`);

  function sanitizeObjectPermissions(list = []) {
    return list
      .filter(op => op && typeof op.object === 'string' && op.object.trim())
      .map(op => ({
        object: op.object.trim(),
        allowCreate: !!op.allowCreate,
        allowDelete: !!op.allowDelete,
        allowEdit:   !!op.allowEdit,
        allowRead:   !!op.allowRead,
        modifyAllRecords: !!op.modifyAllRecords,
        viewAllRecords:   !!op.viewAllRecords,
      }));
  }
  const base = {
    fullName: psName,
    label: ps.label || psName,
    hasActivationRequired: ps.hasActivationRequired || false,
    fieldPermissions: Array.isArray(ps.fieldPermissions) ? ps.fieldPermissions.slice() : [],
    objectPermissions: sanitizeObjectPermissions(ps.objectPermissions)
  };

  for (const e of entries) {
    const field = `${e.objectName}.${e.fieldApiName}`;
    const i = base.fieldPermissions.findIndex(fp => fp.field === field);
    const fp = { field, readable: !!e.readable, editable: !!e.editable };
    if (i === -1) base.fieldPermissions.push(fp);
    else base.fieldPermissions[i] = fp;
  }

  const upd = await conn.metadata.update('PermissionSet', base);
  const ur = Array.isArray(upd) ? upd[0] : upd;
  if (!ur || String(ur.success) !== 'true') {
    const msg = arr(ur?.errors).map(e => e?.message || e).join('; ') || 'Unknown error updating Permission Set';
    throw new Error(`[Permissionset] Update failed: ${msg}`);
  }
  log.info(`[Permissionset] fieldPermissions merged on ${psName}`);
}

export async function assignPermissionSetToUser(conn, { permissionSetName, userId, maxTries = 10, retryMs = 1500, log = console }) {
  const psName = sanitizePsName(permissionSetName);
  let psId = null;

  for (let t = 0; t < maxTries && !psId; t++) {
    const found = await conn.sobject('PermissionSet').find({ Name: psName }, 'Id').limit(1);
    psId = found?.[0]?.Id || null;
    if (!psId) await sleep(retryMs);
  }
  if (!psId) throw new Error(`[Permissionset] ${psName} not visible via data API yet; try again shortly.`);

  const existing = await conn.sobject('PermissionSetAssignment')
    .find({ AssigneeId: userId, PermissionSetId: psId }, 'Id')
    .limit(1);
  if (existing?.length) {
    log.info(`[Permissionset] Already assigned: ${psName} -> ${userId}`);
    return;
  }

  await conn.sobject('PermissionSetAssignment').create({ AssigneeId: userId, PermissionSetId: psId });
  log.info(`[Permissionset] Assigned: ${psName} -> ${userId}`);
}

export async function grantFieldAccessWithPermSet(conn, {
  permissionSetName,
  permissionSetLabel = permissionSetName,
  grants,
  assignToUserId = null,
  log = console
}) {
  const psName = await ensurePermissionSetExists(conn, { name: permissionSetName, label: permissionSetLabel, log });
  await upsertFieldPermissions(conn, { permissionSetName: psName, entries: grants, log });
  if (assignToUserId) await assignPermissionSetToUser(conn, { permissionSetName: psName, userId: assignToUserId, log });
  return psName;
}
