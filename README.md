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

Then it asks **where to install** (a local folder; Enter accepts the default, `~/Echlon`), and only then for your
**access key**. If you chose both products it asks whether one key covers both; answer `n` to enter a key for the
UI and a different one for the engine. The key is the **Echlon licence key** (`ech_lic_...`) you were given. It
is typed with an asterisk shown for each character, is kept only in memory for this run, is sent only to the Echlon download service,
and is never written to disk or printed. Without a valid key nothing is installed.

What a key allows decides what you get. A UI key installs the UI, an engine key the engine, a key for both
installs both. If a key does not include something you asked for, the installer says so and installs the rest.
A key that has been withdrawn, a suspended customer, or a licence that has ended is told so by name.

## What it does

1. Asks the Echlon download service (`service.txt`) whether the key may have each product, and downloads the
   **signed, built** release it hands back from a short-lived link. It never clones source code, and the release
   storage's own credentials never reach the customer's computer.
2. Checks the release signature against the key in `release-pubkey.txt`, then checks the download is exactly
   what was signed. If either fails, nothing is installed and nothing is changed.
3. Unpacks it to `~/Echlon` (or `--dir`), keeping the previous version so an update can be rolled back.
   If the package carries a setup step (the UI installs its own dependencies with `npm ci`), it runs it before
   putting the version in place; only that one command is ever run. A package that needs a newer Node than yours
   is refused up front.
4. If you installed both, makes a private access token for the engine and sets the UI up to use it. You never
   see or type it.
5. Writes `start-ui` and `start-engine` scripts.

Everything it does is shown as it happens: each step is named, the download has a progress bar (percentage, size and
speed, redrawn in place on a terminal and one line per tenth when the output is a file), and the slow setup step
shows how long it has been running. It is plain ASCII, so it reads the same in cmd, PowerShell, Windows Terminal
and a Linux shell.

Needs Node 20 or newer. If it is missing, the script says how to install it (and offers `winget` on Windows).

## Options (for scripting)

```
node installer/install.mjs --product ui|engine|both --dir <folder> --token-env ECHLON_PACK_TOKEN
```

`--ui-key-env` and `--engine-key-env` name a separate variable per product. The key is read from the named
environment variable, never from the command line. `--service <url>` points at another download service, and is
accepted only for a test on this machine (plain http to loopback).

## For the operator

- `products.json` names the private release repositories. `release-pubkey.txt` holds the **public** release key
  (base64 SPKI, `node scripts/release.mjs pubkey` in the engine repo). The pack refuses to run with the placeholder.
- `service.txt` is the address of the download service (`POST /v1/download`, in the engine repo, served by
  `npm run operator`). It holds the one read-only token for the private release repositories; customers never do.
- Manage who has what, terms, products and expiry from the admin page or `npm run licence` in the engine repo.
- An operator can still install without the service by giving a read-only GitHub token (`ghp_...`,
  `github_pat_...`) as the key; anything that is not a licence key is read as one.

## Tests

`npm test` runs against stand-ins for the download service and for the GitHub API, including a redirect to a
second host to prove the key is not forwarded. The service contract was also run end to end against the engine
repo's real route. It has not yet been run against the real private repositories or the hosted service.
