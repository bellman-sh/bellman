/**
 * The one filter a provisioning connector sends (SCIM spec, D9): `userName eq "<address>"` to find the person it
 * is about to push, or `externalId eq "<its id>"`. One clause, `eq`, a double-quoted value with `\"` and `\\`
 * escapes; the attribute and the operator in any case. Anything else is an `invalidFilter`: a connector that
 * sends more than this is asking a question this server will not answer, and saying so beats a wrong page.
 */
export interface ScimFilter {
  attribute: "userName" | "externalId";
  value: string;
}

const CLAUSE = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

export function parseFilter(filter: string): ScimFilter | { error: string } {
  const match = CLAUSE.exec(filter);
  if (!match) return { error: 'only userName eq "<address>" and externalId eq "<id>" are supported' };
  const attribute = match[1].toLowerCase() === "username" ? "userName" : "externalId";
  const raw = match[2].replace(/\\(.)/g, "$1");
  return { attribute, value: attribute === "userName" ? raw.toLowerCase() : raw };
}
