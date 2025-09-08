// lib/runContext.js
// Shared runtime context for the current data loader run.
// Keeps track of orgId (and optionally other state) in memory.

let orgId = null;

/**
 * Set the current Org Id for this run.
 * Call this once after authentication / metadata snapshot.
 */
export function setOrgId(id) {
  if (!id || typeof id !== "string") {
    throw new Error("runContext.setOrgId: id must be a non-empty string");
  }
  orgId = id.trim();
}

/**
 * Get the current Org Id.
 * Throws if not set yet.
 */
export function getOrgId() {
  if (!orgId) {
    throw new Error("runContext.getOrgId: Org Id has not been set yet.");
  }
  return orgId;
}

/**
 * Check if Org Id is set.
 */
export function hasOrgId() {
  return Boolean(orgId);
}

/**
 * Reset Org Id (useful in tests).
 */
export function resetOrgId() {
  orgId = null;
}
