# Echlon customer pack

Installs Echlon on a customer's computer. Run one script, choose what to install, enter your access key.

| Computer | Run |
| :--- | :--- |
| Windows | double-click `install.bat` |
| Linux / macOS | `sh install.sh` |

You will see:

```
Echlon customer pack
  1) Echlon UI
  2) Echlon Engine
  3) Both (the full ecosystem)
  4) Quit
```

Then it asks for your **access key**. The key is typed without being shown, is kept only in memory for this
run, is sent only to GitHub, and is never written to disk or printed. Without a valid key nothing is installed.

What the key allows decides what you get. A key for the UI installs the UI; a key for both installs both. If
a key does not include something you asked for, the installer says so and installs the rest.

## What it does

1. Downloads the **signed, built** release for each product you chose. It never clones source code.
2. Checks the release signature against the key in `release-pubkey.txt`, then checks the download is exactly
   what was signed. If either fails, nothing is installed and nothing is changed.
3. Unpacks it to `~/Echlon` (or `--dir`), keeping the previous version so an update can be rolled back.
4. If you installed both, makes a private access token for the engine and sets the UI up to use it. You never
   see or type it.
5. Writes `start-ui` and `start-engine` scripts.

Needs Node 20 or newer. If it is missing, the script says how to install it (and offers `winget` on Windows).

## Options (for scripting)

```
node installer/install.mjs --product ui|engine|both --dir <folder> --token-env ECHLON_PACK_TOKEN
```

The key is read from the named environment variable, never from the command line.

## For the operator

- `products.json` names the private release repositories. `release-pubkey.txt` holds the **public** release key
  (base64 SPKI, `node scripts/release.mjs pubkey` in the engine repo). The pack refuses to run with the placeholder.
- A key is a read-only GitHub token on the release repositories. One covering both repositories installs both.
- Manage who has what, terms and expiry with `npm run licence` in the engine repo.

## Tests

`npm test` runs against a stand-in for the GitHub API, including a redirect to a second host to prove the key is
not forwarded. It has not yet been run against the real private repositories.
