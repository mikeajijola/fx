// Vendored Omniform validator; see PROVENANCE.md. Only schema loading is adapted.
import schema from "./omniform.schema.json" with { type: "json" };
import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export class OmniformValidationError extends Error {
  constructor(issues) {
    super(`Invalid Omniform declaration (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "OmniformValidationError";
    this.issues = issues;
  }
}

/** JSON Schema is the sole authority for required fields, types and shapes. */
export function validateStructure(input) {
  const valid = validateSchema(input);
  return {
    valid,
    issues: valid ? [] : validateSchema.errors.map(error => ({
      path: error.instancePath || "$",
      message: error.message,
      keyword: error.keyword
    }))
  };
}

/** Semantic validation only covers relationships JSON Schema cannot express. */
export function validateSemantics(input) {
  const structural = validateStructure(input);
  if (!structural.valid) return { valid: false, issues: [], skipped: true };
  const issues = [];
  const issue = (path, message) => issues.push({ path, message });
  const capabilities = new Set();
  const capabilityById = new Map();
  const resources = new Set();
  const resourceById = new Map();
  const realisations = new Map();
  const globalIds = new Map();
  const unique = (id, path) => {
    if (globalIds.has(id)) issue(path, `duplicates ${globalIds.get(id)}`);
    else globalIds.set(id, path);
  };
  input.spec.capabilities.forEach((capability, index) => {
    capabilities.add(capability.id);
    capabilityById.set(capability.id, capability);
    unique(capability.id, `spec.capabilities.${index}.id`);
    const requirements = new Set();
    capability.requires.forEach((requirement, ri) => {
      if (requirements.has(requirement.id)) issue(`spec.capabilities.${index}.requires.${ri}.id`, "duplicates a requirement in this capability");
      requirements.add(requirement.id);
    });
  });
  for (const [family, items] of Object.entries(input.spec.resources ?? {})) {
    items.forEach((resource, index) => {
      resources.add(resource.id);
      resourceById.set(resource.id, { family, resource });
      unique(resource.id, `spec.resources.${family}.${index}.id`);
    });
  }
  input.spec.capabilities.forEach((capability, index) => {
    capability.realisation?.resources?.forEach((id, ri) => {
      if (!resources.has(id)) issue(`spec.capabilities.${index}.realisation.resources.${ri}`, `references unknown resource ${id}`);
    });
  });
  (input.spec.realisations ?? []).forEach((realisation, index) => {
    unique(realisation.id, `spec.realisations.${index}.id`);
    realisations.set(realisation.id, realisation);
    if (!capabilities.has(realisation.capability)) issue(`spec.realisations.${index}.capability`, `references unknown capability ${realisation.capability}`);
    const capability = capabilityById.get(realisation.capability);
    const requirements = new Set((capability?.requires ?? []).map(item => item.id));
    realisation.participants.forEach((participant, pi) => {
      const resource = resourceById.get(participant.resource);
      if (!resource) issue(`spec.realisations.${index}.participants.${pi}.resource`, `references unknown resource ${participant.resource}`);
      participant.supplies?.forEach((requirement, si) => {
        if (!requirements.has(requirement)) issue(`spec.realisations.${index}.participants.${pi}.supplies.${si}`, `references unknown requirement ${requirement} on capability ${realisation.capability}`);
        else if (resource && !resource.resource.offers?.includes(requirement)) issue(`spec.realisations.${index}.participants.${pi}.supplies.${si}`, `resource ${participant.resource} does not offer requirement ${requirement}`);
      });
    });
  });
  input.spec.capabilities.forEach((capability, index) => {
    capability.realisations?.forEach((id, ri) => {
      const realisation = realisations.get(id);
      if (!realisation) issue(`spec.capabilities.${index}.realisations.${ri}`, `references unknown realisation ${id}`);
      else if (realisation.capability !== capability.id) issue(`spec.capabilities.${index}.realisations.${ri}`, `realisation ${id} belongs to capability ${realisation.capability}`);
    });
  });
  if (input.spec.stewardship) {
    if (!capabilities.has(input.spec.stewardship.capability)) issue("spec.stewardship.capability", `references unknown capability ${input.spec.stewardship.capability}`);
    const realisation = realisations.get(input.spec.stewardship.realisation);
    if (!realisation) issue("spec.stewardship.realisation", `references unknown realisation ${input.spec.stewardship.realisation}`);
    else if (realisation.capability !== input.spec.stewardship.capability) issue("spec.stewardship.realisation", "must realise the stewardship capability");
    const autonomy = input.spec.stewardship.autonomy;
    if (autonomy) {
      const dutyByPermission = new Map();
      autonomy.duties.forEach((duty, index) => duty.permissions.forEach(permission => {
        if (dutyByPermission.has(permission)) issue(`spec.stewardship.autonomy.duties.${index}.permissions`, `${permission} is assigned more than once`);
        else dutyByPermission.set(permission, duty.actor);
      }));
      for (const permission of ["propose", "approve", "merge", "apply", "observe"]) if (!dutyByPermission.has(permission)) issue("spec.stewardship.autonomy.duties", `must assign ${permission}`);
      if (dutyByPermission.get("propose") === dutyByPermission.get("approve")) issue("spec.stewardship.autonomy.duties", "proposer and independent approver must be different actors");
      if (autonomy.mode !== "recommend" && !autonomy.expiresAt) issue("spec.stewardship.autonomy.expiresAt", "is required for autonomous modes");
      if (autonomy.activeFrom && autonomy.expiresAt && Date.parse(autonomy.activeFrom) >= Date.parse(autonomy.expiresAt)) issue("spec.stewardship.autonomy.expiresAt", "must be later than activeFrom");
    }
  }
  input.spec.operations.forEach((operation, index) => {
    unique(operation.id, `spec.operations.${index}.id`);
    if (!capabilities.has(operation.capability)) issue(`spec.operations.${index}.capability`, `references unknown capability ${operation.capability}`);
    const requiredFamilies = new Set((capabilityById.get(operation.capability)?.requires ?? []).map(item => item.primitiveFamily));
    operation.providerDependencies?.forEach((family, di) => {
      if (!requiredFamilies.has(family)) issue(`spec.operations.${index}.providerDependencies.${di}`, `family ${family} is not required by capability ${operation.capability}`);
    });
  });
  return { valid: issues.length === 0, issues, skipped: false };
}

export function validateOmniform(input) {
  const structural = validateStructure(input);
  if (!structural.valid) return { valid: false, phase: "structural", issues: structural.issues };
  const semantic = validateSemantics(input);
  return { valid: semantic.valid, phase: semantic.valid ? null : "semantic", issues: semantic.issues };
}

export function assertOmniform(input) {
  const result = validateOmniform(input);
  if (!result.valid) throw new OmniformValidationError(result.issues);
  return input;
}
