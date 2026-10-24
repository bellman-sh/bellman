/**
 * The A2A v1.0 AgentCards (ADR 0033, spec D8): one per public room, and Bellman's own. Every field the spec's
 * `AgentCard` marks required is here (`name`, `description`, `supportedInterfaces`, `version`, `capabilities`,
 * `defaultInputModes`, `defaultOutputModes`, `skills`), and so are the fields an `AuthorizationCodeOAuthFlow` requires
 * (`authorizationUrl`, `tokenUrl`, `scopes`). Runtime-free, like the public routes that serve them.
 *
 * A card claims only what is built: the 1.0 JSON-RPC interface, streaming, no push, no extended card.
 * The 0.3 interface (Task 12) goes in `interfaces` in `card`, beside the 1.0 one; 0.3 has no `tenant`, so its url names the room.
 */
import { PACKAGE_VERSION } from "../ui/assets.js";

/** What a card needs of a public room: the `tenant` `/a2a` accepts for it (its public name, else its id), and its words. */
export interface PublicRoomView {
  tenant: string;
  name: string;
  purpose: string | null;
}

const ROOMS = "https://bellman.sh/r/";
const SCOPE = "bellman";

/** The sentence every room card carries, so a caller's model knows before it asks (spec D7). */
const PUBLIC_SENTENCE = "Questions sent here and the room's answers are public on the room's page.";

const skill = (description: string) => ({ id: "ask", name: "Ask the room", description, tags: ["room"] });

/**
 * What a server's card says it accepts. `oauth` is false for the Node server, which has bearer keys only: a card
 * must not advertise a scheme its `/a2a` refuses.
 */
export interface CardOptions { oauth: boolean }

const BEARER = { httpAuthSecurityScheme: { description: "A Bellman key, sent as a bearer token.", scheme: "Bearer" } };

/** The auth every card shares. The `oauth` scheme has no field for a resource, so its description carries it. */
function security(origin: string, { oauth }: CardOptions) {
  if (!oauth) return { securitySchemes: { bearer: BEARER }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] };
  return {
    securitySchemes: {
      bearer: BEARER,
      oauth: {
        oauth2SecurityScheme: {
          description:
            `Sign in with OAuth. Request resource=${origin}/a2a when you authorize: a token minted for any other resource ` +
            `(the default, with none named, is ${origin}/mcp) is refused here. The resource's metadata is at ` +
            `${origin}/.well-known/oauth-protected-resource/a2a.`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/authorize`,
              tokenUrl: `${origin}/token`,
              scopes: { [SCOPE]: "Use your Bellman account." },
              pkceRequired: true,
            },
          },
          oauth2MetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }, { schemes: { oauth: { list: [SCOPE] } } }],
  };
}

function card(origin: string, how: CardOptions, name: string, description: string, ask: string, tenant?: string) {
  const interfaces = [{ url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", ...(tenant === undefined ? {} : { tenant }) }];
  return {
    name,
    description,
    supportedInterfaces: interfaces,
    version: PACKAGE_VERSION,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    ...security(origin, how),
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [skill(ask)],
  };
}

/** A public room's card. `origin` is the server's own, which serves `/a2a`; the Worker also takes OAuth, the default. */
export const roomCard = (room: PublicRoomView, origin: string, how: CardOptions = { oauth: true }): object =>
  card(
    origin,
    how,
    room.name,
    [room.purpose?.trim(), PUBLIC_SENTENCE].filter(Boolean).join(" "),
    "The room's members discuss your question and answer as one.",
    room.tenant,
  );

/** Bellman's own card: no `tenant`, because it is not a room. A message with no tenant is told which room to name. */
export const bellmanCard = (origin: string): object =>
  card(
    origin,
    { oauth: true },
    "Bellman",
    "Bellman is where people and their coding agents work together in shared rooms. Public rooms answer questions from outside agents.",
    `Name a public room in tenant to ask it. Public rooms are listed at ${ROOMS}.`,
  );

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A card as a response: JSON, cacheable for five minutes, with a strong ETag from the body's SHA-256, and a 304 for
 * a request that holds it. `extra` is the headers a route adds to every answer (CORS).
 */
export async function cardResponse(card: object, ifNoneMatch: string | null, extra: Record<string, string> = {}): Promise<Response> {
  const body = JSON.stringify(card);
  const etag = `"${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))}"`;
  const headers = { "cache-control": "public, max-age=300", etag, "access-control-expose-headers": "etag", ...extra };
  const held = ifNoneMatch !== null && ifNoneMatch.split(",").some((v) => {
    const t = v.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  });
  return held
    ? new Response(null, { status: 304, headers })
    : new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
}
