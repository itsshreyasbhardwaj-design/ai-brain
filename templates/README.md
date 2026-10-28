# Community templates

A template is a `brain.config.json` — configuration only. **No template contains
records, credentials or connection tokens**, and the import path drops anything
it does not recognise rather than trusting it.

## Using one

**Settings → Import → Configuration**, or:

```bash
pnpm brain config import templates/solo-developer-os.json
```

It saves as a new version. Your existing records are untouched, and the previous
configuration stays in the version history.

## Sharing yours

```bash
pnpm brain config export --out my-setup.json
```

Check the file before you share it. It should contain your profile, modules,
knowledge categories, goal titles, dashboard layout and privacy preferences —
and nothing else. Open a pull request adding it here with a short description of
who it is for.
