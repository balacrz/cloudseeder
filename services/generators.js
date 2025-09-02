// services/generators.js
// ESM module
// Generators receive the full raw data object (as loaded from the dataFile)
// and the cumulative idMaps produced by prior steps. They must return an array
// of records ready for the loader's shaping/transform/reference pipeline.

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

function requiredId(idMapBucket, key, context) {
  const out = idMapBucket?.[key];
  if (!out) {
    throw new Error(
      `[generators] Missing ID for key='${key}' in ${context}. ` +
      `Check step order and identify.matchKey for the parent object.`
    );
  }
  return out;
}

export const generators = {
  /**
   * Expert↔Location junctions
   * - Input: raw BKAI__Expert__c (seed) with BKAI__Location__c pointing to seed Location Id
   * - Output: array of junction records with resolved SFDC Ids
   */
  generateExpertLocationJunctions: (data, idMaps) => {
    const experts = data["BKAI__Expert__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);
    const expIdMap = idMaps["BKAI__Expert__c"] || Object.create(null);

    // Build junctions
    const junctions = experts.map((e) => {
      const expertId = requiredId(expIdMap, e.Name, "idMaps['BKAI__Expert__c']");
      // e.BKAI__Location__c holds the seed Location.Id; our Location idMap is keyed by seed Id
      const locationId = requiredId(
        locIdMap,
        e.BKAI__Location__c,
        "idMaps['BKAI__Location__c'] (keyed by seed Location.Id)"
      );
      return {
        BKAI__Expert__c: expertId,
        BKAI__Location__c: locationId
      };
    });

    return junctions;
  },

  /**
   * Clone shift pattern templates for each Location
   * - Input: template array BKAI__Shift_Pattern__c and locations array BKAI__Location__c
   * - Output: patterns per location with BKAI__Location__c resolved via idMaps
   *   (RecordTypeId / Business Unit defaults come from mapping defaults/constants)
   */
  generateShiftPatternsPerLocation: (data, idMaps) => {
    const templates = data["BKAI__Shift_Pattern__c"] || [];
    const locations = data["BKAI__Location__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);
    const out = [];
    for (const loc of locations) {
      const sfLocId = requiredId(
        locIdMap,
        loc.Id, // seed Location.Id; idMap is keyed by this due to mapping's matchKey
        "idMaps['BKAI__Location__c'] (keyed by seed Location.Id)"
      );

      for (const tpl of templates) {
        // Keep the original template Name so uniqueness is (Name + Location) per mapping.validate.uniqueBy
        out.push({
          ...tpl,
          BKAI__Location__c: sfLocId
          // No hardcoded Business Unit or RecordTypeId here—mappings/defaults handle them
        });
      }
    }
    return out;
  },

  /**
   * Generate child Locations with parent hierarchy resolved
   * - Input: BKAI__Location__c where child rows have BKAI__Parent_Location__c pointing to seed parent Id
   * - Output: child rows with BKAI__Parent_Location__c replaced by the parent SFDC Id
   *   (Other defaults like Description/Business Unit/Active are handled by mapping transforms/defaults)
   */
  generateChildLocationsWithHierarchy: (data, idMaps) => {
    const all = data["BKAI__Location__c"] || [];
    const locIdMap = idMaps["BKAI__Location__c"] || Object.create(null);

    const children = all.filter((loc) => !!loc.BKAI__Parent_Location__c);

    return children.map((loc) => {
      const parentSeedKey = loc.BKAI__Parent_Location__c; // this is a seed parent Id
      const parentSfId = requiredId(
        locIdMap,
        parentSeedKey,
        "idMaps['BKAI__Location__c'] (keyed by seed Location.Id)"
      );

      return {
        ...loc,
        BKAI__Parent_Location__c: parentSfId
        // Do NOT set BKAI__Description__c or defaults here—let mapping transform/defaults handle those
      };
    });
  }
};
