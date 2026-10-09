# Saved presets and the room designer. Design

**Date:** 2026-10-09
**Status:** approved in conversation; implementation plan to follow
**Builds on:** #72 (room manifests: the cite and author arms, the validator), #183 and #184 (the room routes, their caller, CORS and CSRF rules)
**Related:** #84 (a situational preset library; not this), #49 (the HTTP API for the panel), bellman-sh/dash (the Presets page)
**Citations:** by symbol, of the code as it stood when this was written.

## Problem

A room's shape is its roles, the verbs each holds, which seats report, and the heartbeat. Today it is authored as JSON inside a `bellman_start` call, or as `.bellman/room.yaml` in a repo, or it is one of three presets that cannot be changed (`PRESETS` in `src/manifest.ts`). A person who runs the same kind of room often writes the same roles every time, and nothing shows a room's shape before it starts except the manifest text.

This adds presets a person saves, a page in dash to design them, and a way for an agent to start a room from one by name.

## Decisions

**D1. Presets are per person.** A saved preset belongs to the identity that saved it, and only that identity's sessions can cite it. The built-ins stay code and stay read-only; editing one means cloning it into a preset of your own. Org-shared presets and #84's library are out of scope.

**D2. A saved preset is a room shape without the room.** Its fields are what the author arm (`AuthorShape`) declares, minus `room` and `purpose`, which stay per room (manifests spec D3): `mode`, `heartbeat_on`, `roles` (each with `can`, `description`, `reports`), `default_role`, `creator_role`; plus its `name` and an optional `description` of at most 300 characters. `PresetShape` is that shape, strict. A name follows the role-key grammar (`slugShape("preset names")`) and may not be a built-in's (`PRESET_NAMES`). ponytail: `MAX_PRESETS = 20` per person; the first person past it wants a reason, not a bigger number.

**D3. Saving runs the room validator.** The server composes `{ room: <name>, ...preset }` and runs `resolveManifest` on it. A refusal is the `ManifestError` message, word for word, so the designer shows exactly what `bellman_start` would have said, and a preset that saved always starts.

**D4. Stored per person in the registry.** `RegistryDO` already holds the per-person indexes (`us:`, `um:`, `cr:`); presets go under `pr:<userId>:<name>`, a prefix no other key uses (the plan checks every key the registry writes). `MemoryStore` keeps a map per user. Four `BellmanStore` methods, async like every other:

- `listPresets(userId): Promise<SavedPreset[]>`, in name order
- `getPreset(userId, name): Promise<SavedPreset | undefined>`
- `putPreset(userId, preset, cap): Promise<"saved" | "full">`, where replacing an existing name never counts against the cap, and the count and the write are one operation in the object
- `deletePreset(userId, name): Promise<boolean>`

`SavedPreset` is the D2 shape plus `updatedAt`. The store contract suite (`tests/helpers/store-contract.ts`) pins all four on both stores.

**D5. An HTTP API beside the room routes.** `src/http/presets.ts` exports `presetRoutes(request, deps)` with the same deps shape as `roomRoutes`, mounted beside it in `src/worker.ts` and `src/app.ts`. Same caller, same CORS for the panel's origins, same preflight, and `csrfRefusal` on every write a cookie makes.

- `GET /presets` answers `{ builtin: [{ name, description, preset }], mine: [{ name, description, preset, updated_at }] }`. The built-ins are expanded from `PRESETS` so the page can show and clone them.
- `PUT /presets/:name` takes a `PresetShape` body (the name in the path wins over none in the body; a body naming another name is refused), runs D3, and saves: 200 with the stored preset; 400 with the validator's message; 409 `builtin` for a built-in's name; 409 `full` past the cap. The body is bounded (32 KB) and read only after the caller and the CSRF check pass.
- `DELETE /presets/:name` answers 204, or 404 when there is no such preset of yours.

No route reads another person's presets: every read and write is keyed by the caller's own `userId`.

**D6. `bellman_start` cites any name.** `CiteShape`'s `preset` becomes `slugShape("preset names")` rather than the enum, so the SDK's validation lets a saved name through. In the handler, before `resolveManifest`: a built-in name resolves as today; any other name is looked up with `getPreset(identity.userId, name)`, and if found the input becomes the author arm `{ room, purpose, ...saved }`; if not, the refusal names both lists, `unknown preset "x" (built-in: pair, swarm, review; yours: a, b)`. `resolveManifest` stays pure and runtime-free: it only ever sees a built-in cite or an author arm.

The room is expanded at start, as every room is (manifests spec D6), so editing or deleting a preset never changes a room that exists. The stored manifest's `preset` stays `PresetName | null`: a room started from a saved preset records `null`. That field is in the connect preview's trusted spine, and a saved name is text its creator chose; the roles a joiner is shown, descriptions included, travel in the untrusted skin as authored roles do today. `.bellman/room.yaml` gets this for free: the bridge hands the parsed file to `bellman_start` unvalidated (`bridge.ts`, the `fromFile` path).

The tool's description gains one clause: "or the name of a preset you saved at dash.bellman.sh/presets". Its schema loses the three-name enum. §11 measures the change.

**D7. Dash: a Presets page.** A nav item and two routes, `/presets` and `/presets/$name` (with `new` for a fresh one and `?from=<name>` to clone). The list shows the built-ins with Clone, and yours with Edit and Delete. The editor:

- name, description, mode (pair or swarm), heartbeat (off, or a number and a unit, the `heartbeat_on` grammar)
- a roles table: key, description, the six verbs as checkboxes, reports; add and remove a role
- the default and creator role, picked from the keys in the table
- a preview of what a joiner sees: the role table the join screen shows, with each seat's verbs and whether it reports
- Save is the PUT; a refusal is shown verbatim beside the field it names when the message names one, at the top otherwise. Delete asks first.

**D8. Export writes `room.yaml` with the roles spelled out.** A Copy button emits the author arm, `room` set to the preset's name and `purpose` to its description for the person to edit, never `preset: <name>`. A repo's file is read by teammates whose accounts do not hold your preset. The emitter is a few lines in dash for this fixed shape, every string double-quoted; a dash test pins its output for a fixture, and a bellman test parses the same fixture text with the bridge's YAML loader and resolves it, so the two stay in step.

## Trust

A saved preset is its owner's own text, shown only to its owner in dash. Once a room starts from it, the role descriptions are creator text and reach joiners in the untrusted skin, exactly as an authored manifest's do. Nothing new enters the preview's trusted spine (D6). The routes key every read and write by the caller (D5). No change weakens how peer content is handled.

## Testing

Every assertion runs against a broken version first and must fail there.

- Store contract: list in name order; get one and none; put new, replace, and refuse past the cap while a replace still succeeds at the cap; delete one and none; one person never sees another's.
- Routes (`tests/http-presets.test.ts`): 401 with no caller; CORS on refusals; a cookie write without the panel's origin refused; GET lists built-ins expanded and mine; PUT refused with the validator's message for a creator role not in the roles; 409 for `pair`; 409 past the cap; DELETE 204 then 404; a body over the bound refused before it is parsed.
- `bellman_start`: a saved preset cited by name starts a room whose roles equal the preset's; a room started, then the preset edited, keeps its roles; an unknown name lists both kinds; a built-in still resolves; the stored `preset` is null for a saved one; the description names the dash page.
- Tool surface: the start tool's schema accepts any slug for `preset`; §11 re-measured.
- Dash: the list renders both groups; Clone fills the editor; the verb checkboxes and role pickers produce the PUT body; a refusal shows; the YAML emitter's fixture output.
- Bellman: the same fixture text parses with the bridge's loader and resolves.

## Out of scope

- Starting a room from dash. It needs a creator seat with no agent attached and a way for an agent to claim it, which is its own design, next.
- Presets shared across an org, and #84's situational library.
- Editing the built-ins in place.
- Versioning presets. A room is expanded at start, so there is nothing to migrate.

## Acceptance

- In dash, a person clones `review`, renames a role, gives the reviewer `request_actions`, saves it, and sees the joiner's view.
- An agent told to start a room "from my preset `<name>`" starts one whose roles are that preset's, and its join screen shows them.
- Copy room.yaml gives a file that, committed to a repo, starts the same room for a teammate.
