# Design skill integration

The AI website generator uses the reviewed
`emil-design-eng` instructions from
[emilkowalski/skills](https://github.com/emilkowalski/skills) as vendored
system-prompt guidance on every Claude generation and JSON-repair request.

This deliberately does not enable Anthropic's beta native Agent Skills runtime.
The upstream skill is prompt-only, so direct prompt composition preserves the
service's existing streaming, attachment, and raw-JSON response behavior.

## Pinned source

- Commit: `7bb7061b5cf7de15ea1aeaf00fbd9e6592a20fce`
- File: `ai/skills/emil-design-eng/SKILL.md`
- Normalized SHA-256:
  `433b5a239cda18e0576e4e558532e7e53512e21fafe5b85db4894c28ec399b72`
- License and provenance: `ai/third_party/emilkowalski-skills/`

The service never downloads prompt instructions at runtime. When enabled, a
missing or changed skill file fails service startup rather than silently
generating without the requested guidance.

## Ubuntu deployment

The normal `ai/install.sh` flow copies the skill to:

```text
/opt/fula-ai-service/skills/emil-design-eng/SKILL.md
/opt/fula-ai-service/third_party/emilkowalski-skills/LICENSE
/opt/fula-ai-service/third_party/emilkowalski-skills/NOTICE.md
```

It also adds this setting to `/opt/fula-ai-service/.env`:

```dotenv
CLAUDE_DESIGN_SKILL_ENABLED=true
```

After deployment, verify and restart:

```bash
cd /opt/fula-ai-service
sha256sum skills/emil-design-eng/SKILL.md
npm run build
sudo systemctl restart fula-ai-service
sudo systemctl status fula-ai-service --no-pager
sudo journalctl -u fula-ai-service -n 100 --no-pager
```

The `sha256sum` output must match the pinned hash above. The startup log should
say `Design skill enabled` and show the abbreviated commit and hash.

No `npx skills add`, `~/.claude/skills` installation, Anthropic skill ID, or
server-side GitHub clone is required.

## Live Claude smoke test

First revoke the key that was exposed in conversation history and create a new
one. Supply the replacement through the environment or `ai/.env`; do not paste
it into source code, a command, test output, or chat. Then run:

```bash
cd /opt/fula-ai-service
npm run test:live-design
```

The opt-in test calls the real `generateWebsite` path with the skill forced on.
It validates the returned file contract, paths, local HTML references, absence
of unexpected remote URLs, and reduced-motion handling without printing file
contents or the credential. It is intentionally excluded from normal CI.

## Emergency rollback

Set the flag to `false` and restart the service:

```bash
sudo sed -i 's/^CLAUDE_DESIGN_SKILL_ENABLED=.*/CLAUDE_DESIGN_SKILL_ENABLED=false/' /opt/fula-ai-service/.env
sudo systemctl restart fula-ai-service
```

This restores the exact legacy system prompt without deleting the vendored
files. Re-enable it after the incident is understood and tested.

## Updating the skill

Do not track the upstream `main` branch automatically. Review a specific
commit, replace the vendored file and license if needed, update the provenance
commit and normalized hash in code/docs, then run the full test suite and a
staging Claude smoke test.
