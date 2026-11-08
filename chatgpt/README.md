# Bellman in ChatGPT's plugin directory

This folder is the package OpenAI's plugin directory takes. It holds no code: the
plugin is Bellman's hosted MCP server, `https://mcp.bellman.sh/mcp`, and the package
names it, describes it and gives OpenAI's reviewers their test cases.

- `plugin.json`: the portable Agent Plugins manifest. The listing is under
  `extensions.com.openai.interface`, and the review cases and release notes are under
  `review` and `publication`.
- `mcp.json`: the one remote server, signed in by OAuth with dynamic client
  registration, which the server advertises at
  `/.well-known/oauth-authorization-server`.
- `assets/`: the listing icon (`logo.png`, 1024 px) and the composer icon
  (`icon.png`, 512 px), copied from bellman.sh.
- `build.sh`: packs `dist/bellman-chatgpt.zip`.

`tests/chatgpt-plugin.test.ts` holds the package to the portal's limits and rules:
- the field lengths and the four listing URLs
- no prices and no comparisons in the listing text
- square icons
- one remote server at the production URL, with no headers or secrets
- five positive and three negative review cases that name tools the server really lists
- the three explicit annotation hints on every tool

Keep `version` equal to `package.json`'s.

## Listing rules

OpenAI refuses a listing that:
- mentions price, plans, trials or discounts
- compares Bellman with another product
- calls itself official or best
- puts "MCP" or "Plugin" in the name

Keep the listing text factual. Prices and comparisons belong on bellman.sh.

## Submitting

1. **Verify the publisher.** At platform.openai.com/settings/organization/general,
   complete business verification as Code Nerd LLC. The directory shows the
   verified name. You must be the organization's owner, or hold Apps Management
   Write.
2. **Pack and upload.** Run `./chatgpt/build.sh`. Then go to
   platform.openai.com/plugins, choose **Upload new or existing plugin**, choose
   the verified identity, and upload `chatgpt/dist/bellman-chatgpt.zip`. Fix any
   metadata findings in this folder and upload again.
3. **Verify the domain.** Under **MCPs**, choose **Connect**. The portal shows a
   challenge token.
   1. Put it in `wrangler.toml` as `OPENAI_APPS_CHALLENGE = "<token>"`.
   2. Merge, and deploy.
   3. Check that `https://mcp.bellman.sh/.well-known/openai-apps-challenge`
      returns the token and nothing else.
   4. Finish **Connect**, sign in, and wait for the tool scan.
4. **Fill in review details.** Under **Metadata & Skills → Review information →
   Review details**:
   - **Reviewer credentials:** a dedicated test account. It must work without MFA,
     email or SMS codes, or magic links. Bellman signs in only through GitHub or
     Google, so that means a GitHub or Google account with two-factor
     authentication off that a reviewer can use from a new device.
   - **The demo video:** a public URL walking through the five positive cases.
     Put it in `review.demo_recording_url` and upload again, or enter it there.
   - **Countries:** choose them here, or add `publication.countries`.
5. **Submit for review.** Choose **Submit for review** and complete the
   attestations. Feedback comes by email. To appeal a rejection, reply to that
   email.

After publication, OpenAI rescans the server daily and picks up tool changes on
its own. Upload a new ZIP only when `plugin.json`, `mcp.json` or the icons change.
