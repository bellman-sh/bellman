/**
 * What a pushed resource and a PATCH carry (SCIM spec, D2, D8). Three attributes are held: `userName`, the
 * address, lowercased whole; `externalId`, the IdP's own id for the person; and `active`. Everything else a
 * connector pushes (a name, a title, an emails list) is accepted and not stored, so a connector that sends it
 * does not fail on it. Entra sends `"False"` for a boolean and `Replace` for an op, so both are read.
 */
import type { ScimUserPatch } from "../types.js";

export type ScimPatch = ScimUserPatch;

/** An address: anything with an `@` in it, lowercased whole. */
export function readUserName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return name.includes("@") && name.length <= 254 ? name : undefined;
}

/** A boolean, or the strings true and false in any case. */
export function readActive(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  return lower === "true" ? true : lower === "false" ? false : undefined;
}

/** The three attributes of a pushed resource (POST and PUT), `active` true when absent. */
export function readUser(body: Record<string, unknown>): { userName: string; externalId: string | null; active: boolean } | { error: string } {
  const userName = readUserName(body.userName);
  if (userName === undefined) return { error: "userName must be an email address" };
  if (body.externalId !== undefined && body.externalId !== null && typeof body.externalId !== "string") return { error: "externalId must be a string" };
  const active = body.active === undefined ? true : readActive(body.active);
  if (active === undefined) return { error: "active must be true or false" };
  return { userName, externalId: typeof body.externalId === "string" ? body.externalId : null, active };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One attribute's value into the patch, or the reason it cannot go there. */
function take(patch: ScimPatch, attribute: string, value: unknown, op: "add" | "replace" | "remove"): string | undefined {
  const name = attribute.toLowerCase();
  if (name === "username") {
    if (op === "remove") return "userName cannot be removed";
    const userName = readUserName(value);
    if (userName === undefined) return "userName must be an email address";
    patch.userName = userName;
  } else if (name === "externalid") {
    if (op === "remove") {
      patch.externalId = null;
    } else {
      if (typeof value !== "string") return "externalId must be a string";
      patch.externalId = value;
    }
  } else if (name === "active") {
    if (op === "remove") return "active cannot be removed";
    const active = readActive(value);
    if (active === undefined) return "active must be true or false";
    patch.active = active;
  }
  // Any other attribute is accepted and not stored.
  return undefined;
}

/** The PATCH body's `Operations` applied to nothing: what changed, or the first error and its scimType. */
export function applyOperations(operations: unknown): ScimPatch | { error: string; scimType: "invalidValue" | "invalidSyntax" } {
  if (!Array.isArray(operations)) return { error: "Operations must be a list", scimType: "invalidSyntax" };
  const patch: ScimPatch = {};
  for (const operation of operations) {
    if (!isObject(operation) || typeof operation.op !== "string") return { error: "each operation needs an op", scimType: "invalidSyntax" };
    const op = operation.op.toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") return { error: `op must be add, replace or remove, not ${operation.op}`, scimType: "invalidValue" };
    if (typeof operation.path === "string" && operation.path) {
      const refused = take(patch, operation.path, operation.value, op);
      if (refused) return { error: refused, scimType: "invalidValue" };
    } else if (op === "remove") {
      return { error: "remove needs a path", scimType: "invalidValue" };
    } else {
      if (!isObject(operation.value)) return { error: "an operation without a path needs an object value", scimType: "invalidValue" };
      for (const [attribute, value] of Object.entries(operation.value)) {
        const refused = take(patch, attribute, value, op);
        if (refused) return { error: refused, scimType: "invalidValue" };
      }
    }
  }
  return patch;
}
